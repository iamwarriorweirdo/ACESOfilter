
import { serve } from "inngest/node";
import { Inngest } from "inngest";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'node:buffer';

export const inngest = new Inngest({ id: "hr-rag-app" });

// Helper: Delay to avoid spamming APIs
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Download file safely
async function fetchFileBuffer(url: string) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  let targetUrl = url;
  if (url.includes('cloudinary.com')) targetUrl = url.replace('http://', 'https://');

  let res = await fetch(targetUrl, { headers });
  if (!res.ok && targetUrl.includes('cloudinary.com')) {
    // Retry logic for Cloudinary variants
    let altUrl = targetUrl.includes('/image/upload/')
      ? targetUrl.replace('/image/upload/', '/raw/upload/')
      : targetUrl.replace('/raw/upload/', '/image/upload/');
    if (altUrl !== targetUrl) res = await fetch(altUrl, { headers });
  }
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return await res.arrayBuffer();
}

// Helper: Log usage to DB
async function logUsage(model: string, tokens: number, duration: number, status: 'success' | 'error', errorMsg?: string) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
  if (!dbUrl) return;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));

    try {
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS id TEXT`;
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS tokens INTEGER`;
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS duration_ms INTEGER`;
      await sql`ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS status TEXT`;
    } catch (migErr) { /* Ignore if fails, usually means it already exists or lack of perms */ }

    await sql`INSERT INTO token_usage (id, model, tokens, duration_ms, status, timestamp, error_msg) 
              VALUES (${Math.random().toString(36).substring(2, 10)}, ${model}, ${tokens}, ${duration}, ${status}, ${Date.now()}, ${errorMsg || null})`;
  } catch (e) {
    // Silently log to console, don't crash the background job for logging errors
    console.error("Log Usage Database Error:", e);
  }
}

// Helper: Update DB status
async function updateDbStatus(docId: string, status: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
  if (!dbUrl) return;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    const content = isError ? `ERROR_DETAILS: ${status}` : `Đang xử lý: ${status}...`;
    await sql`UPDATE documents SET extracted_content = ${content} WHERE id = ${docId}`;
  } catch (e) { console.error("DB Update Failed", e); }
}

// Helper: Compress PDF using Adobe PDF Services
async function compressPdfWithAdobe(buffer: Buffer, config: any): Promise<Buffer> {
  if (!config.adobeClientId || !config.adobeClientSecret) {
    console.warn("[Adobe] Missing credentials, skipping compression.");
    return buffer;
  }

  try {
    const {
      ServicePrincipalCredentials,
      ExecutionContext,
      CompressPDF,
      PDFServices,
      SDKError,
      ServiceUsageError
    } = await import('@adobe/pdfservices-node-sdk');
    const { Readable } = await import('stream');

    console.log("[Adobe] Starting PDF compression...");

    const credentials = new ServicePrincipalCredentials({
      clientId: config.adobeClientId,
      clientSecret: config.adobeClientSecret,
      organizationId: config.adobeOrgId || undefined
    });

    const executionContext = ExecutionContext.create(credentials);
    const pdfServices = new PDFServices({ credentials });

    const stream = Readable.from(buffer);
    const inputAsset = await pdfServices.upload({
      readStream: stream,
      mimeType: "application/pdf"
    });

    // Create Operation - Level: MEDIUM is usually best balance
    const operation = new CompressPDF.Operation();
    const params = new CompressPDF.Params({
      compressionLevel: CompressPDF.CompressionLevel.MEDIUM
    });
    operation.setParams(params);

    const pollingJob = await pdfServices.submit({
      operation,
      inputAssets: [inputAsset]
    });

    const outputAsset = await pdfServices.getJobResult({
      pollingJob,
      assetType: "output"
    });

    const resultStream = await pdfServices.getContent({ asset: outputAsset });

    // Convert stream back to buffer
    const chunks: any[] = [];
    for await (const chunk of resultStream) {
      chunks.push(chunk);
    }
    const compressedBuffer = Buffer.concat(chunks);

    console.log(`[Adobe] Compression success. Reduced from ${buffer.length} to ${compressedBuffer.length} bytes.`);
    return compressedBuffer;
  } catch (error: any) {
    console.error("[Adobe] Compression Failed:", error.message || error);
    return buffer; // Fallback to original
  }
}

// Helper: AI Robust Call with Fallback
async function safeAiCall(ai: any, params: any, type: 'generate' | 'embed' = 'generate') {
  const start = Date.now();
  const model = params.model || 'unknown';
  try {
    let result;
    if (type === 'generate') result = await ai.models.generateContent(params);
    else {
      // For the modular @google/genai SDK, embedding usually expects 'contents' (plural)
      // to avoid the "Value must be a list given an array path requests[]" error.
      const embedParams = { ...params };
      if ((embedParams as any).content && !(embedParams as any).contents) {
        (embedParams as any).contents = [(embedParams as any).content];
        delete (embedParams as any).content;
      }
      result = await ai.models.embedContent(embedParams);
    }

    // Log success
    const duration = Date.now() - start;
    const tokens = type === 'generate' ? (result.usageMetadata?.totalTokenCount || result.response?.usageMetadata?.totalTokenCount || 0) : 0;
    console.log(`[AI Success] Model: ${model}, Type: ${type}, Tokens: ${tokens}, Duration: ${duration}ms`);
    await logUsage(model, tokens, duration, 'success');
    return result;
  } catch (error: any) {
    const duration = Date.now() - start;
    await logUsage(model, 0, duration, 'error', error.message);

    const msg = error.message?.toLowerCase() || "";
    const isQuota = msg.includes('429') || msg.includes('quota') || msg.includes('limit');
    const isNotFound = msg.includes('404') || msg.includes('not_found') || msg.includes('not found');

    if (isQuota || isNotFound) {
      console.warn(`[AI Fallback] ${isQuota ? 'Quota' : 'Model 404'} hit for ${params.model}. Switching to gemini-1.5-flash-latest.`);
      const { ...paramsWithoutModel } = params;

      let fallbackParams = {
        ...paramsWithoutModel,
        model: type === 'generate' ? 'gemini-1.5-flash-latest' : 'text-embedding-004'
      };

      if (type === 'embed') {
        if ((fallbackParams as any).content && !(fallbackParams as any).contents) {
          (fallbackParams as any).contents = [(fallbackParams as any).content];
          delete (fallbackParams as any).content;
        }
      }

      if (type === 'generate') return await ai.models.generateContent(fallbackParams);
      return await ai.models.embedContent(fallbackParams);
    }
    throw error;
  }
}

async function extractPdfWithAdobe(buffer: Buffer, config: any): Promise<{ text: string; structuredData?: any }> {
  if (!config.adobeClientId || !config.adobeClientSecret) {
    return { text: "" };
  }

  try {
    const {
      ServicePrincipalCredentials,
      ExecutionContext,
      PDFServices,
      PDFExtract,
      SDKError
    } = await import('@adobe/pdfservices-node-sdk');
    const { Readable } = await import('stream');
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');
    const { exec } = await import('child_process');

    console.log("[Adobe] Starting PDF Deep Extract...");

    const credentials = new ServicePrincipalCredentials({
      clientId: config.adobeClientId,
      clientSecret: config.adobeClientSecret,
      organizationId: config.adobeOrgId || undefined
    });

    const pdfServices = new PDFServices({ credentials });
    const stream = Readable.from(buffer);
    const inputAsset = await pdfServices.upload({
      readStream: stream,
      mimeType: "application/pdf"
    });

    // Create Operation - Extracting Text and Tables
    const params = new PDFExtract.Params({
      getCharInfo: false,
      elementsToExtract: [PDFExtract.ElementType.TEXT, PDFExtract.ElementType.TABLES]
    });
    const operation = new PDFExtract.Operation({ params });

    const pollingJob = await pdfServices.submit({
      operation,
      inputAssets: [inputAsset]
    });

    const outputAsset = await pdfServices.getJobResult({
      pollingJob,
      assetType: "output"
    });

    const resultStream = await pdfServices.getContent({ asset: outputAsset });

    // Adobe Extract returns a ZIP. We need to parse structuredData.json inside.
    const tempDir = path.join(os.tmpdir(), `adobe-${Date.now()}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const zipPath = path.join(tempDir, "output.zip");

    const fileStream = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      resultStream.pipe(fileStream);
      resultStream.on('end', resolve);
      resultStream.on('error', reject);
    });

    // Simple unzip using JSZip or similar if available, or just use 'unzip' on linux/mac
    // Since this is Windows, we might need a library. 
    // Let's use 'adm-zip' if it's in package.json or try to import it.
    // For now, I'll assume we can use a temporary simplified approach or just read the stream.
    // Actually, Adobe SDK has examples using 'adm-zip'.

    const AdmZip = await import('adm-zip').then(m => m.default).catch(() => null);
    if (!AdmZip) {
      console.warn("[Adobe] adm-zip not found, returning placeholder text.");
      return { text: "ZIP extraction failed - missing adm-zip dependency." };
    }

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    let extractedText = "";
    let jsonData = null;

    for (const entry of zipEntries) {
      if (entry.entryName === "structuredData.json") {
        jsonData = JSON.parse(entry.getData().toString('utf8'));
      }
    }

    if (jsonData && jsonData.elements) {
      // Reconstruct text from elements with some structure
      extractedText = jsonData.elements
        .filter((e: any) => e.Text)
        .map((e: any) => e.Text)
        .join("\n");

      console.log(`[Adobe] Deep Extract success. Extracted ${extractedText.length} characters.`);
    }

    // Cleanup
    try { fs.unlinkSync(zipPath); fs.rmdirSync(tempDir); } catch (e) { }

    return { text: extractedText, structuredData: jsonData };
  } catch (error: any) {
    console.error("[Adobe] Deep Extract Failed:", error.message || error);
    return { text: "" };
  }
}

const processFileInBackground = inngest.createFunction(
  {
    id: "process-file-background",
    concurrency: { limit: 2 },
    retries: 3,
    cancelOn: [{ event: "app/process.file", match: "data.docId" }]
  },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, fileType, docId } = event.data;
    console.log(`[Inngest] Starting background process for ${fileName} (ID: ${docId})`);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
      // --- STEP 1: FETCH CONFIG ---
      const systemConfig = await step.run("fetch-system-config", async () => {
        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) return null;
        try {
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
          const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
          if (rows.length > 0) return JSON.parse(rows[0].data);
        } catch (e) { console.error("Config fetch failed", e); }
        return null;
      });

      const ocrModel = systemConfig?.ocrModel || 'gemini-3-flash-preview';
      const analysisModel = systemConfig?.analysisModel || 'gemini-3-flash-preview';

      // --- STEP 2: DOWNLOAD & INITIAL PARSE ---
      const parseResult = await step.run("download-and-parse", async () => {
        await updateDbStatus(docId, "Scanning");
        const arrayBuffer = await fetchFileBuffer(url);
        let fileBuffer: Buffer = Buffer.from(arrayBuffer as any);

        if (systemConfig?.enableAdobeCompression && (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf'))) {
          try {
            await updateDbStatus(docId, "Optimizing PDF (Adobe)");
            fileBuffer = await compressPdfWithAdobe(fileBuffer, systemConfig);
          } catch (e) { console.error("[Inngest] Adobe compression failed", e); }
        }

        let extractedText = "";
        let parseMethod = "unknown";
        let needsAiVision = false;

        const lowFileName = fileName.toLowerCase();
        if (lowFileName.endsWith('.docx')) {
          try {
            const mammoth = await import('mammoth');
            const res = await mammoth.extractRawText({ buffer: fileBuffer });
            extractedText = res.value;
            parseMethod = "mammoth";
            if (!extractedText || extractedText.trim().length < 50) needsAiVision = true;
          } catch (e) { needsAiVision = true; }
        } else if (fileType.includes('pdf') || lowFileName.endsWith('.pdf')) {
          // Attempt Adobe Extract
          if (systemConfig?.enableAdobeCompression) {
            try {
              await updateDbStatus(docId, "Deep Extracting (Adobe)");
              const adobeRes = await extractPdfWithAdobe(fileBuffer, systemConfig);
              if (adobeRes.text && adobeRes.text.length > 100) {
                extractedText = adobeRes.text;
                parseMethod = "adobe-extract";
              }
            } catch (e) { }
          }
          // Fallback to pdf-parse
          if (!extractedText) {
            try {
              const pdfParse = await import('pdf-parse');
              const data = await pdfParse.default(fileBuffer);
              extractedText = data.text;
              parseMethod = "pdf-parse";
            } catch (e) { needsAiVision = true; }
          }
        } else if (lowFileName.endsWith('.txt')) {
          extractedText = fileBuffer.toString('utf-8');
          parseMethod = "raw-text";
        } else {
          needsAiVision = true;
        }

        if (!extractedText || extractedText.trim().length < 20) needsAiVision = true;

        return {
          extractedText,
          parseMethod,
          needsAiVision,
          // Optimization: If small, keep buffer in memory to avoid re-downloading
          fileBase64: (needsAiVision && fileBuffer.length < 3.8 * 1024 * 1024) ? fileBuffer.toString('base64') : null
        };
      });

      // --- STEP 3: RECOVERY & REFINEMENT (MARKDOWN) ---
      const finalResult = await step.run("ocr-recovery-and-markdown", async () => {
        let text = parseResult.extractedText;
        let method = parseResult.parseMethod;

        // A. Vision Recovery
        if (parseResult.needsAiVision) {
          await updateDbStatus(docId, "AI Vision Scan");
          let base64 = parseResult.fileBase64;
          if (!base64) {
            const ab = await fetchFileBuffer(url);
            base64 = Buffer.from(ab).toString('base64');
          }
          const mime = (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) ? 'application/pdf' :
            (fileName.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'image/png');

          const visionRes = await safeAiCall(ai, {
            model: ocrModel,
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { data: base64, mimeType: mime } },
                { text: "OCR Task: Extract ALL text from this document accurately. Use Markdown for structure. Do NOT summarize." }
              ]
            }]
          });
          text = visionRes.response?.text() || visionRes.text || "";
          method = `vision-${ocrModel}`;
        }

        // B. Markdown Refinement (The Goal)
        if (text && text.length > 20) {
          await updateDbStatus(docId, "Structuring Content");
          const refineRes = await safeAiCall(ai, {
            model: 'gemini-1.5-flash-latest',
            contents: [{
              role: 'user',
              parts: [{ text: `Task: Convert the following raw OCR/extraction into clean, professional Markdown.\n1. Preserve ALL data and Vietnamese fonts.\n2. Structure tables correctly.\n3. Use headers and lists for hierarchy.\n\nRAW TEXT:\n${text.substring(0, 30000)}` }]
            }]
          });
          text = refineRes.response?.text() || text;
        }

        return { text, method };
      });

      const extractedContent = finalResult.text;
      const parseMethod = finalResult.method;

      if (!extractedContent || extractedContent.length < 10) {
        throw new Error("OCR Failed: No readable text found.");
      }

      // --- STEP 4: METADATA & DB SAVE ---
      await step.run("finalize-and-save", async () => {
        await updateDbStatus(docId, "Finalizing metadata");
        const res = await safeAiCall(ai, {
          model: analysisModel,
          contents: [{
            role: 'user',
            parts: [{
              text: `Analyze this content and return JSON:
              { "title": "...", "summary": "...", "key_information": ["...", "..."], "language": "vi|en" }
              
              CONTENT:
              ${extractedContent.substring(0, 15000)}`
            }]
          }],
          config: { responseMimeType: 'application/json' }
        });
        const meta = JSON.parse(res.response?.text() || res.text || "{}");
        const fullMetadata = {
          ...meta,
          full_text_content: extractedContent,
          parse_method: parseMethod
        };

        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) throw new Error("Missing DATABASE_URL");
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));

        await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullMetadata)}, status = 'completed' WHERE id = ${docId}`;

        // Create embedding
        const embText = `File: ${fileName}\nTitle: ${fullMetadata.title}\nSummary: ${fullMetadata.summary}\nContent: ${extractedContent.substring(0, 2000)}`;
        const embRes = await safeAiCall(ai, {
          model: 'text-embedding-004',
          content: { parts: [{ text: embText }] },
          outputDimensionality: 768
        } as any, 'embed');

        const vector = embRes.embeddings?.[0]?.values || embRes.embedding?.values || [];

        if (vector.length === 768 && process.env.PINECONE_API_KEY) {
          const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
          const index = pc.index(process.env.PINECONE_INDEX_NAME!);
          await index.upsert([{
            id: docId,
            values: vector,
            metadata: { filename: fileName, text: embText.substring(0, 5000) }
          }] as any);
        }
      });

      await updateDbStatus(docId, "Thành công (Indexed)");
      console.log(`[Inngest] Process complete for ${fileName}`);

    } catch (error: any) {
      await updateDbStatus(docId, `${error.message || "Unknown System Error"}`, true);
      throw error; // Rethrow to show failure in Inngest Dashboard
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});
