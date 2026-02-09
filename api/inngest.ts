
import { serve } from "inngest/node";
import { Inngest } from "inngest";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'node:buffer';

export const inngest = new Inngest({ id: "hr-rag-app" });

// Helper: Download file safely
async function fetchFileBuffer(url: string) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  let targetUrl = url;
  if (url.includes('cloudinary.com')) targetUrl = url.replace('http://', 'https://');

  let res = await fetch(targetUrl, { headers });
  if (!res.ok && targetUrl.includes('cloudinary.com')) {
    let altUrl = targetUrl.includes('/image/upload/')
      ? targetUrl.replace('/image/upload/', '/raw/upload/')
      : targetUrl.replace('/raw/upload/', '/image/upload/');
    if (altUrl !== targetUrl) res = await fetch(altUrl, { headers });
  }
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return await res.arrayBuffer();
}

// Helper: Update DB status
async function updateDbStatus(docId: string, message: string, isError = false, append = true) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
  if (!dbUrl) return;
  try {
    // @ts-ignore
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0]; // HH:MM:SS
    const logPrefix = isError ? `[${timestamp}] [ERROR]` : `[${timestamp}] [INFO]`;
    const newLogLine = `${logPrefix} ${message}`;

    if (append && !isError) {
        await sql`UPDATE documents SET extracted_content = ${newLogLine} WHERE id = ${docId}`;
    } else {
        const finalMsg = isError ? `ERROR_DETAILS: ${message}` : message;
        await sql`UPDATE documents SET extracted_content = ${finalMsg} WHERE id = ${docId}`;
    }
  } catch (e) { console.error("DB Update Failed", e); }
}

async function safeAiCall(ai: any, params: any, type: 'generate' | 'embed' = 'generate') {
  try {
    if (type === 'generate') return await ai.models.generateContent(params);
    
    // Embed handling with fallback
    const embedParams = { ...params };
    if (embedParams.content && !embedParams.contents) {
        embedParams.contents = [embedParams.content];
        delete embedParams.content;
    }
    
    try {
        return await ai.models.embedContent(embedParams);
    } catch (e: any) {
         if (e.message?.includes("404") || e.status === 404 || e.code === 404) {
            console.warn(`[Fallback] Embedding ${embedParams.model} failed (404) -> trying embedding-001`);
            embedParams.model = "embedding-001";
            return await ai.models.embedContent(embedParams);
         }
         throw e;
    }
  } catch (error: any) {
    throw error;
  }
}

function sanitizeModelName(model: string): string {
  if (model === 'gemini-3-flash') return 'gemini-3-flash-preview';
  if (model === 'gemini-3-pro') return 'gemini-3-pro-preview';
  return model;
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
      // --- STEP 1: CONFIG ---
      const systemConfig = await step.run("fetch-system-config", async () => {
        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) return null;
        try {
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
          const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
          if (rows.length > 0) return JSON.parse(rows[0].data);
        } catch (e) { }
        return null;
      });

      const rawOcr = systemConfig?.ocrModel || 'gemini-3-flash-preview';
      const rawAnalysis = systemConfig?.analysisModel || 'gemini-3-flash-preview';
      const ocrModel = sanitizeModelName(rawOcr);
      const analysisModel = sanitizeModelName(rawAnalysis);

      // --- STEP 2: DOWNLOAD & PARSE ---
      const parseResult = await step.run("download-and-parse", async () => {
        await updateDbStatus(docId, "Initializing download sequence...");
        const arrayBuffer = await fetchFileBuffer(url);
        const fileBuffer = Buffer.from(arrayBuffer as any);

        let extractedText = "";
        let parseMethod = "unknown";
        let needsAiVision = false;

        const lowFileName = fileName.toLowerCase();
        const lowFileType = (fileType || "").toLowerCase();

        // 1. DOCX (Mammoth)
        if (lowFileName.endsWith('.docx') || lowFileType.includes('wordprocessingml')) {
          try {
            await updateDbStatus(docId, "Running Mammoth (DOCX Parser)...");
            // @ts-ignore
            const mammoth = await import('mammoth');
            const res = await mammoth.extractRawText({ buffer: fileBuffer });
            extractedText = res.value;
            parseMethod = "mammoth";
            if (!extractedText || extractedText.trim().length < 50) {
                 await updateDbStatus(docId, "Mammoth result weak (<50 chars). Marking for AI Vision.");
                 needsAiVision = true;
            }
          } catch (e: any) { 
             await updateDbStatus(docId, `Mammoth Failed: ${e.message}. Fallback to AI Vision.`);
             needsAiVision = true; 
          }
        } 
        // 2. PDF
        else if (lowFileName.endsWith('.pdf') || lowFileType.includes('pdf')) {
          try {
              await updateDbStatus(docId, "Running PDF-Parse (Standard)...");
              // @ts-ignore
              const pdfParse = await import('pdf-parse');
              const data = await pdfParse.default(fileBuffer);
              extractedText = data.text;
              parseMethod = "pdf-parse";
          } catch (e: any) {
              await updateDbStatus(docId, `PDF-Parse Failed: ${e.message}. Fallback to AI Vision.`);
              needsAiVision = true;
          }
        }
        // 3. Text
        else if (lowFileName.endsWith('.txt')) {
             extractedText = fileBuffer.toString('utf-8');
             parseMethod = "raw-text";
        }
        else {
             needsAiVision = true;
        }

        if (!extractedText || extractedText.trim().length < 20) {
            if (!needsAiVision) await updateDbStatus(docId, "Text extraction yielded empty result. Forcing AI Vision.");
            needsAiVision = true;
        }

        return {
          extractedText, // Text is usually small enough
          parseMethod,
          needsAiVision,
          // FIX: Do NOT return the huge base64 string here to avoid Inngest step size limit.
          // The next step (ocr-recovery) will automatically re-download the file if this is null.
          fileBase64: null 
        };
      });

      // --- STEP 3: RECOVERY / OCR ---
      const finalResult = await step.run("ocr-recovery-and-markdown", async () => {
        let text = parseResult.extractedText;
        let method = parseResult.parseMethod;

        if (parseResult.needsAiVision) {
          await updateDbStatus(docId, `Activating ${ocrModel} (Computer Vision)...`);
          let base64 = parseResult.fileBase64;
          
          if (!base64) {
            // Re-download strategy to bypass step size limit
            const ab = await fetchFileBuffer(url);
            base64 = Buffer.from(ab).toString('base64');
          }

          let mime = 'image/png';
          if (fileName.toLowerCase().endsWith('.pdf')) mime = 'application/pdf';
          else if (fileName.toLowerCase().endsWith('.jpg') || fileName.toLowerCase().endsWith('.jpeg')) mime = 'image/jpeg';
          else if (fileName.toLowerCase().endsWith('.webp')) mime = 'image/webp';
          
          if (fileName.toLowerCase().endsWith('.docx')) {
             if (!text) throw new Error("DOCX Parsing failed and Gemini does not support DOCX inline OCR.");
          }

          const visionRes = await safeAiCall(ai, {
            model: ocrModel,
            contents: [{
              role: 'user',
              parts: [
                { inlineData: { data: base64, mimeType: mime } },
                { text: "OCR Task: Extract ALL text from this document accurately. Use Markdown. Preserve tables." }
              ]
            }]
          });
          text = visionRes.text || "";
          method = `vision-${ocrModel}`;
        }
        return { text, method };
      });

      const extractedContent = finalResult.text;
      const parseMethod = finalResult.method;

      if (!extractedContent || extractedContent.length < 10) {
        throw new Error("OCR Failed: No readable text found after all attempts.");
      }

      // --- STEP 4: METADATA & INDEX ---
      await step.run("finalize-metadata-and-vector", async () => {
          await updateDbStatus(docId, "Generating Metadata & Indexing JSON...");
          
          const metaRes = await safeAiCall(ai, {
              model: analysisModel,
              contents: [{
                  role: 'user',
                  parts: [{ text: `Analyze this content and return JSON:
                  { "title": "...", "summary": "...", "key_information": ["...", "..."], "language": "vi|en" }
                  
                  CONTENT:
                  ${extractedContent.substring(0, 20000)}` }]
              }],
              config: { responseMimeType: 'application/json' }
          });
          
          const meta = JSON.parse(metaRes.text || "{}");
          const fullMetadata = {
            ...meta,
            full_text_content: extractedContent,
            parse_method: parseMethod
          };

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          // Robust update with auto-migration fallback
          try {
             await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullMetadata)}, status = 'completed' WHERE id = ${docId}`;
          } catch (err: any) {
             if (err.message?.includes('column "status"')) {
                 console.warn("[Auto-Migration] 'status' column missing. Adding it now...");
                 await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT`;
                 await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullMetadata)}, status = 'completed' WHERE id = ${docId}`;
             } else {
                 throw err;
             }
          }

          const embText = `File: ${fileName}\nTitle: ${fullMetadata.title}\nSummary: ${fullMetadata.summary}\nContent: ${extractedContent.substring(0, 2000)}`;
          const embRes = await safeAiCall(ai, {
              model: "text-embedding-004",
              contents: [{ parts: [{ text: embText }] }]
          }, 'embed');
          
          const vectorValues: number[] = embRes.embeddings?.[0]?.values || [];

          if (process.env.PINECONE_API_KEY && vectorValues.length > 0) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              const index = pc.index(process.env.PINECONE_INDEX_NAME!);
              await index.upsert([{
                  id: docId,
                  values: vectorValues,
                  metadata: { filename: fileName, text: embText.substring(0, 4000) }
              }] as any);
          }
      });
    } catch (error: any) {
      await updateDbStatus(docId, error.message || "Unknown Error", true, false);
      throw error;
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});
