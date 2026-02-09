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

async function compressPdfWithAdobe(buffer: Buffer, config: any): Promise<Buffer> {
  if (!config.adobeClientId || !config.adobeClientSecret) return buffer;
  try {
    // @ts-ignore
    const adobeSdk = await import('@adobe/pdfservices-node-sdk');
    const { ServicePrincipalCredentials, PDFServices, CompressPDF, ExecutionContext } = adobeSdk;
    // @ts-ignore
    const { Readable } = await import('stream');

    const credentials = new ServicePrincipalCredentials({
      clientId: config.adobeClientId,
      clientSecret: config.adobeClientSecret,
      organizationId: config.adobeOrgId || undefined
    });
    const pdfServices = new PDFServices({ credentials });
    const stream = Readable.from(buffer);
    const inputAsset = await pdfServices.upload({ readStream: stream, mimeType: "application/pdf" });

    const operation = new CompressPDF.Operation();
    operation.setParams(new CompressPDF.Params({ compressionLevel: CompressPDF.CompressionLevel.MEDIUM }));

    const pollingJob = await pdfServices.submit({ operation, inputAssets: [inputAsset] });
    const outputAsset = await pdfServices.getJobResult({ pollingJob, assetType: "output" });
    const resultStream = await pdfServices.getContent({ asset: outputAsset });

    const chunks: any[] = [];
    for await (const chunk of resultStream) chunks.push(chunk);
    return Buffer.concat(chunks);
  } catch (e) { return buffer; }
}

async function safeAiCall(ai: any, params: any) {
  const start = Date.now();
  try {
     return await ai.models.generateContent(params);
  } catch (error: any) {
    if (error.message?.includes('429') || error.message?.includes('404')) {
       return await ai.models.generateContent({ ...params, model: 'gemini-1.5-flash-latest' });
    }
    throw error;
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
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    try {
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

      const ocrModel = systemConfig?.ocrModel || 'gemini-3-flash-preview';
      const analysisModel = systemConfig?.analysisModel || 'gemini-3-flash-preview';

      const parseResult = await step.run("download-and-parse", async () => {
        await updateDbStatus(docId, "Scanning");
        const arrayBuffer = await fetchFileBuffer(url);
        let fileBuffer: Buffer = Buffer.from(arrayBuffer as any);

        if (systemConfig?.enableAdobeCompression && (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf'))) {
           fileBuffer = await compressPdfWithAdobe(fileBuffer, systemConfig);
        }

        let extractedText = "";
        let parseMethod = "unknown";
        let needsVision = false;

        if (fileName.toLowerCase().endsWith('.docx')) {
          try {
            // @ts-ignore
            const mammoth = await import('mammoth');
            const res = await mammoth.extractRawText({ buffer: fileBuffer });
            extractedText = res.value;
            parseMethod = "mammoth";
            if (!extractedText || extractedText.trim().length < 50) needsVision = true;
          } catch (e) { needsVision = true; }
        } else if (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) {
          try {
            // @ts-ignore
            const pdfParse = (await import('pdf-parse')).default;
            const data = await pdfParse(fileBuffer);
            extractedText = data.text;
            parseMethod = "pdf-parse";
            if (!extractedText || extractedText.trim().length < 100) needsVision = true;
          } catch (e) { needsVision = true; }
        } else if (fileName.endsWith('.txt')) {
          extractedText = fileBuffer.toString('utf-8');
          parseMethod = "raw-text";
        } else {
          needsVision = true;
        }

        return {
          text: extractedText,
          method: parseMethod,
          needsVision: needsVision || (!extractedText || extractedText.trim().length < 20),
          fileBase64: (needsVision || !extractedText) && fileBuffer.length < 3.8 * 1024 * 1024 ? fileBuffer.toString('base64') : null
        };
      });

      let finalText = parseResult.text;
      let finalMethod = parseResult.method;

      if (parseResult.needsVision) {
        const visionResult = await step.run("vision-ocr-recovery", async () => {
          await updateDbStatus(docId, "AI Vision Scan");
          let base64 = parseResult.fileBase64;
          if (!base64) {
            const ab = await fetchFileBuffer(url);
            base64 = Buffer.from(ab).toString('base64');
          }
          const mime = (fileType.includes('pdf') || fileName.toLowerCase().endsWith('.pdf')) ? 'application/pdf' : 'image/png';
          const result = await safeAiCall(ai, {
            model: ocrModel,
            contents: [{
                role: 'user', parts: [
                  { inlineData: { data: base64, mimeType: mime } },
                  { text: "OCR Task: Extract ALL text." }
                ]
            }]
          });
          return { text: result.response?.text() || result.text || "", method: "gemini-vision-3.0" };
        });
        finalText = visionResult.text;
        finalMethod = visionResult.method;
      }

      const metadata = await step.run("extract-metadata", async () => {
        await updateDbStatus(docId, "Finalizing Index");
        const result = await safeAiCall(ai, {
          model: analysisModel,
          contents: [{
            role: 'user', parts: [{
              text: `Analyze this text (max 20k chars): "${finalText.substring(0, 20000)}..."\nReturn JSON Only: { "title": "...", "summary": "...", "key_information": ["..."], "full_text_content": "..." }`
            }]
          }],
          config: { responseMimeType: 'application/json' }
        });
        return result.response?.text() || result.text || "";
      });

      await step.run("save-db", async () => {
        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
        if (!dbUrl) throw new Error("Missing DATABASE_URL");
        // @ts-ignore
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
        await sql`UPDATE documents SET extracted_content = ${metadata} WHERE id = ${docId}`;
      });

      await step.run("index-vector", async () => {
        if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) return;
        await updateDbStatus(docId, "Indexing Vector");
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        const index = pc.index(process.env.PINECONE_INDEX_NAME);

        let contentToEmbed = finalText;
        try {
          const json = JSON.parse(metadata);
          contentToEmbed = `${json.title}\n${json.summary}\n${json.key_information?.join('\n')}`;
        } catch (e) { }

        // Embedding Call
        let vector = [];
        try {
             const embResult = await ai.models.embedContent({
                 model: 'text-embedding-004',
                 contents: [{ parts: [{ text: contentToEmbed.substring(0, 9000) }] }],
                 config: {
                    outputDimensionality: 768
                 }
             });
             const raw = embResult.embeddings?.[0]?.values || [];
             vector = Array.isArray(raw) ? raw.slice(0, 768) : [];
        } catch(e) {}

        if (vector.length === 768) {
            await index.upsert([{
            id: docId,
            values: vector,
            metadata: { text: contentToEmbed.substring(0, 4000), filename: fileName, docId: docId }
            }] as any);
        }
      });
      return { success: true, method: finalMethod };
    } catch (error: any) {
      await step.run("report-error", async () => {
        await updateDbStatus(docId, `${error.message || "Unknown System Error"}`, true);
      });
      throw error;
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});