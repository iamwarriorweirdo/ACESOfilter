
// DO fix: use correct text access and Pinecone upsert format
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
    // @ts-ignore
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
    console.error("Log Usage Database Error:", e);
  }
}

// Helper: Update DB status
async function updateDbStatus(docId: string, status: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
  if (!dbUrl) return;
  try {
    // @ts-ignore
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
    // @ts-ignore
    const adobeSdk = await import('@adobe/pdfservices-node-sdk');
    const {
      ServicePrincipalCredentials,
      ExecutionContext,
      CompressPDF,
      PDFServices
    } = adobeSdk;
    
    // @ts-ignore
    const { Readable } = await import('stream');

    console.log("[Adobe] Starting PDF compression...");

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

    const chunks: any[] = [];
    for await (const chunk of resultStream) {
      chunks.push(chunk);
    }
    const compressedBuffer = Buffer.concat(chunks);

    console.log(`[Adobe] Compression success. Reduced from ${buffer.length} to ${compressedBuffer.length} bytes.`);
    return compressedBuffer;
  } catch (error: any) {
    console.error("[Adobe] Compression Failed:", error.message || error);
    return buffer; 
  }
}

// Helper: AI Robust Call
async function safeAiCall(ai: any, params: any, type: 'generate' | 'embed' = 'generate') {
  const start = Date.now();
  const model = params.model || 'unknown';
  try {
    let result;
    if (type === 'generate') result = await ai.models.generateContent(params);
    else {
      const embedParams = { ...params };
      if ((embedParams as any).content && !(embedParams as any).contents) {
        (embedParams as any).contents = [(embedParams as any).content];
        delete (embedParams as any).content;
      }
      result = await ai.models.embedContent(embedParams);
    }

    const duration = Date.now() - start;
    const tokens = type === 'generate' ? (result.usageMetadata?.totalTokenCount || 0) : 0;
    await logUsage(model, tokens, duration, 'success');
    return result;
  } catch (error: any) {
    const duration = Date.now() - start;
    await logUsage(model, 0, duration, 'error', error.message);
    throw error;
  }
}

async function extractPdfWithAdobe(buffer: Buffer, config: any): Promise<{ text: string; structuredData?: any }> {
  if (!config.adobeClientId || !config.adobeClientSecret) {
    return { text: "" };
  }

  try {
    // @ts-ignore
    const adobeSdk = await import('@adobe/pdfservices-node-sdk');
    const { ServicePrincipalCredentials, PDFServices, PDFExtract } = adobeSdk;
    
    // @ts-ignore
    const { Readable } = await import('stream');
    // @ts-ignore
    const fs = await import('fs');
    // @ts-ignore
    const path = await import('path');
    // @ts-ignore
    const os = await import('os');

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

    const tempDir = path.join(os.tmpdir(), `adobe-${Date.now()}`);
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
    const zipPath = path.join(tempDir, "output.zip");

    const fileStream = fs.createWriteStream(zipPath);
    await new Promise((resolve, reject) => {
      resultStream.pipe(fileStream);
      resultStream.on('end', resolve);
      resultStream.on('error', reject);
    });

    // @ts-ignore
    const AdmZip = await import('adm-zip').then(m => m.default || m).catch(() => null);
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
      extractedText = jsonData.elements
        .filter((e: any) => e.Text)
        .map((e: any) => e.Text)
        .join("\n");
      console.log(`[Adobe] Deep Extract success. Extracted ${extractedText.length} characters.`);
    }

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
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
          const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
          if (rows.length > 0) return JSON.parse(rows[0].data);
        } catch (e) { console.error("Config fetch failed", e); }
        return null;
      });

      const ocrModel = systemConfig?.ocrModel || 'gemini-3-flash-preview';
      const analysisModel = systemConfig?.analysisModel || 'gemini-3-flash-preview';

      // --- STEP 2: DOWNLOAD & PARSE ---
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
            // @ts-ignore
            const mammoth = await import('mammoth');
            const res = await mammoth.extractRawText({ buffer: fileBuffer });
            extractedText = res.value;
            parseMethod = "mammoth";
            if (!extractedText || extractedText.trim().length < 50) needsAiVision = true;
          } catch (e) { needsAiVision = true; }
        } else if (fileType.includes('pdf') || lowFileName.endsWith('.pdf')) {
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
          if (!extractedText) {
            try {
              // @ts-ignore
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
          fileBase64: (needsAiVision && fileBuffer.length < 3.8 * 1024 * 1024) ? fileBuffer.toString('base64') : null
        };
      });

      // --- STEP 3: RECOVERY & REFINEMENT ---
      const finalResult = await step.run("ocr-recovery-and-markdown", async () => {
        let text = parseResult.extractedText;
        let method = parseResult.parseMethod;

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
                { text: "OCR Task: Extract ALL text from this document accurately. Use Markdown." }
              ]
            }]
          });
          // DO fix: access text as property
          text = visionRes.text || "";
          method = `vision-${ocrModel}`;
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
        // DO fix: access text as property
        const meta = JSON.parse(res.text || "{}");
        const fullMetadata = {
          ...meta,
          full_text_content: extractedContent,
          parse_method: parseMethod
        };

        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) throw new Error("Missing DATABASE_URL");
        // @ts-ignore
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));

        await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullMetadata)}, status = 'completed' WHERE id = ${docId}`;

        const embText = `File: ${fileName}\nTitle: ${fullMetadata.title}\nSummary: ${fullMetadata.summary}\nContent: ${extractedContent.substring(0, 2000)}`;
        const embRes = await safeAiCall(ai, {
          model: 'text-embedding-004',
          contents: [{ parts: [{ text: embText }] }],
          outputDimensionality: 768
        } as any, 'embed');

        // DO fix: access embeddings properly
        // FIX: Access 'embeddings' instead of 'embedding'
        const vector = embRes.embeddings?.[0]?.values || [];

        if (vector.length === 768 && process.env.PINECONE_API_KEY) {
          const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
          const index = pc.index(process.env.PINECONE_INDEX_NAME!);
          // DO fix: Pinecone upsert format - Pass array directly
          await index.upsert([{
              id: docId,
              values: vector,
              metadata: { filename: fileName, text: embText.substring(0, 5000) }
            }] as any);
        }
      });

      await updateDbStatus(docId, "Thành công (Indexed)");
    } catch (error: any) {
      await updateDbStatus(docId, `${error.message || "Unknown System Error"}`, true);
      throw error;
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});
