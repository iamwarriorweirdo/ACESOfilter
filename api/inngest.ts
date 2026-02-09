
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

const processFileInBackground = inngest.createFunction(
  {
    id: "process-file-background",
    concurrency: { limit: 2 }, // Allow 2 files at once, Vercel can handle small bursts
    retries: 3,
    cancelOn: [{ event: "app/process.file", match: "data.docId" }]
  },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, fileType, docId } = event.data;
    console.log(`[Inngest] Starting background process for ${fileName} (ID: ${docId})`);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
      // --- STEP 0: FETCH CONFIG ---
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

      // --- STEP 1 & 2: CONSOLIDATED DOWNLOAD & QUICK PARSE (CPU ONLY) ---
      // We merge these to avoid passing large file buffers between Inngest steps
      // (as Inngest has a payload limit of ~4MB).
      const parseResult = await step.run("download-and-parse", async () => {
        console.log(`[Inngest] Step: download-and-parse for ${fileName}`);
        await updateDbStatus(docId, "Scanning");
        const arrayBuffer = await fetchFileBuffer(url);
        let fileBuffer: Buffer = Buffer.from(arrayBuffer as any);

        // --- NEW: ADOBE COMPRESSION PASS ---
        if (systemConfig?.enableAdobeCompression && (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf'))) {
          try {
            await updateDbStatus(docId, "Optimizing PDF (Adobe)");
            fileBuffer = await compressPdfWithAdobe(fileBuffer, systemConfig);
          } catch (e) { console.error("[Inngest] Optional Adobe pass failed", e); }
        }

        let extractedText = "";
        let parseMethod = "unknown";
        let needsAiVision = false;

        if (fileName.toLowerCase().endsWith('.docx')) {
          try {
            const mammoth = await import('mammoth');
            const res = await mammoth.extractRawText({ buffer: fileBuffer });
            extractedText = res.value;
            parseMethod = "mammoth";
            console.log(`[Inngest] Mammoth success: ${extractedText.length} chars extracted from DOCX`);
            if (!extractedText || extractedText.trim().length < 50) {
              console.warn("[Mammoth] Text too short, might be scanned images in DOCX");
              await updateDbStatus(docId, "DOCX extracted 0 text. Attempting AI Vision recovery...");
              needsAiVision = true; // Changed: Allow vision recovery for DOCX
            }
          } catch (e: any) {
            console.error("[Mammoth] Parse failed:", e.message);
          }
        } else if (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
          try {
            const pdfParse = (await import('pdf-parse')).default;
            const data = await pdfParse(fileBuffer);
            extractedText = data.text;
            parseMethod = "pdf-parse";
            console.log(`[Inngest] pdf-parse success: ${extractedText.length} chars extracted from PDF`);
            if (!extractedText || extractedText.trim().length < 100) needsAiVision = true;
          } catch (e: any) {
            console.error("[pdf-parse] Failed:", e.message);
            needsAiVision = true;
          }
        } else if (fileName.endsWith('.txt')) {
          extractedText = fileBuffer.toString('utf-8');
          parseMethod = "raw-text";
        } else {
          // Images or unknown
          needsAiVision = true;
        }

        // Final check for vision need (images/garbage)
        if (!extractedText || extractedText.trim().length < 20) {
          needsAiVision = true;
        }

        return {
          text: extractedText,
          method: parseMethod,
          needsVision: needsAiVision,
          // Optimization: Increase limit to 3.8MB for in-memory transfer
          // This avoids re-downloading the file in the vision step for 90% of documents.
          fileBase64: (needsAiVision && fileBuffer.length < 3.8 * 1024 * 1024) ? fileBuffer.toString('base64') : null
        };
      });

      let finalText = parseResult.text;
      let finalMethod = parseResult.method;

      // --- STEP 3: VISION RECOVERY (AI) ---
      // ONLY runs if CPU parse failed. This is the expensive/slow part.
      // By putting it in its own step, we reset the Vercel Timeout counter!
      if (parseResult.needsVision) {
        const visionResult = await step.run("vision-ocr-recovery", async (): Promise<{ text: string; method: string }> => {
          console.log(`[Inngest] Step: vision-ocr-recovery for ${fileName}`);
          await updateDbStatus(docId, "AI Vision Scan");

          let base64 = parseResult.fileBase64;
          if (!base64) {
            // Re-download if we didn't pass it due to size
            const arrayBuffer = await fetchFileBuffer(url);
            base64 = Buffer.from(arrayBuffer).toString('base64');
          }

          const mimeType = (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) ? 'application/pdf' :
            (fileName.toLowerCase().endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'image/png');

          // Gemini 3 Flash Preview is currently the most available in AI Studio
          const result = await safeAiCall(ai, {
            model: ocrModel,
            contents: [
              {
                role: 'user', parts: [
                  { inlineData: { data: base64, mimeType } },
                  { text: "OCR Task: Extract ALL text from this document accurately. Preserve Vietnamese accents. Return ONLY the raw text." }
                ]
              }
            ]
          });

          const text = result.response?.text() || result.text || "";
          console.log(`[Inngest] Vision OCR complete. Length: ${text.length}`);
          return { text, method: "gemini-vision-3.0" };
        });
        finalText = visionResult.text;
        finalMethod = visionResult.method;
      }

      if (!finalText || finalText.length < 20) {
        throw new Error("OCR Failed: No readable text found even after AI Vision.");
      }

      // --- STEP 4: METADATA EXTRACTION ---
      const metadata = await step.run("extract-metadata", async (): Promise<string> => {
        console.log(`[Inngest] Step: extract-metadata for ${fileName}`);
        await updateDbStatus(docId, "Finalizing Index");
        const result = await safeAiCall(ai, {
          model: analysisModel,
          contents: [{
            role: 'user', parts: [{
              text: `
                    Analyze this text (max 20k chars): "${finalText.substring(0, 20000)}..."
                    Return JSON Only: {
                        "title": "Document Title",
                        "summary": "Brief summary in Vietnamese",
                        "key_information": ["Point 1", "Point 2"],
                        "full_text_content": "Cleaned content"
                    }`
            }]
          }],
          config: { responseMimeType: 'application/json' }
        });
        const text = result.response?.text() || result.text || "";
        console.log(`[Inngest] Metadata extraction complete. Length: ${text.length}`);
        return text;
      });

      // --- STEP 5: SAVE TO DATABASE ---
      await step.run("save-db", async () => {
        console.log(`[Inngest] Step: save-db for ${fileName}`);
        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) throw new Error("Missing DATABASE_URL");
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
        await sql`UPDATE documents SET extracted_content = ${metadata} WHERE id = ${docId}`;
        console.log(`[Inngest] Database update successful for ${docId}`);
      });

      // --- STEP 6: VECTOR INDEXING ---
      await step.run("index-vector", async () => {
        if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) return;

        console.log(`[Inngest] Step: index-vector for ${fileName}`);
        await updateDbStatus(docId, "Indexing Vector");
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        const index = pc.index(process.env.PINECONE_INDEX_NAME);

        let contentToEmbed = finalText;
        try {
          const json = JSON.parse(metadata);
          contentToEmbed = `${json.title}\n${json.summary}\n${json.key_information?.join('\n')}`;
        } catch (e) { }

        const embResult = await safeAiCall(ai, {
          model: 'gemini-embedding-001',
          content: { parts: [{ text: contentToEmbed.substring(0, 9000) }] },
          outputDimensionality: 768
        }, 'embed');

        const rawVector = (embResult as any).embeddings?.[0]?.values || (embResult as any).embedding?.values || [];
        const vector = Array.isArray(rawVector) ? rawVector.slice(0, 768) : [];

        if (vector.length !== 768) {
          throw new Error(`Vector dimension mismatch: Expected 768, got ${vector.length}`);
        }

        await index.upsert([{
          id: docId,
          values: vector,
          metadata: {
            text: contentToEmbed.substring(0, 4000),
            filename: fileName,
            docId: docId
          }
        }] as any);
      });

      return { success: true, method: finalMethod };

    } catch (error: any) {
      console.error(`[Inngest] Fatal Error for ${docId}:`, error);
      await step.run("report-error", async () => {
        await updateDbStatus(docId, `${error.message || "Unknown System Error"}`, true);
      });
      throw error; // Rethrow to show failure in Inngest Dashboard
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});
