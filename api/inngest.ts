
// DO fix: use ai.models.embedContent, text property, and correct Pinecone upsert format
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

async function safeAiCall(ai: any, params: any) {
  try {
     return await ai.models.generateContent(params);
  } catch (error: any) {
    throw error;
  }
}

const processFileInBackground = inngest.createFunction(
  {
    id: "process-file-background",
    concurrency: { limit: 2 },
    retries: 3
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

      const extraction = await step.run("ocr-and-extract", async () => {
          await updateDbStatus(docId, "Scanning & OCR");
          const buffer = await fetchFileBuffer(url);
          const base64 = Buffer.from(buffer).toString('base64');
          
          const mimeType = fileType || (fileName.endsWith('.pdf') ? 'application/pdf' : 'image/png');
          
          const res = await safeAiCall(ai, {
              model: ocrModel,
              contents: [{
                  role: 'user',
                  parts: [
                      { inlineData: { data: base64, mimeType } },
                      { text: "Hãy trích xuất toàn bộ văn bản từ tài liệu này một cách chính xác nhất. Nếu là bảng biểu hãy giữ định dạng markdown." }
                  ]
              }]
          });
          
          // DO fix: use text property instead of text() method
          return res.text;
      });

      await step.run("finalize-metadata-and-vector", async () => {
          await updateDbStatus(docId, "Indexing");
          
          // Phân tích metadata
          const metaRes = await safeAiCall(ai, {
              model: analysisModel,
              contents: [{
                  role: 'user',
                  parts: [{ text: `Phân tích nội dung sau và trả về JSON: { "title": "...", "summary": "...", "key_information": [] }\n\nNỘI DUNG:\n${extraction.substring(0, 10000)}` }]
              }],
              config: { responseMimeType: 'application/json' }
          });
          
          // DO fix: use text property
          const meta = JSON.parse(metaRes.text || "{}");
          const fullContent = { ...meta, full_text: extraction };

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullContent)} WHERE id = ${docId}`;

          // DO fix: use ai.models.embedContent directly
          // Tạo Embedding cho Pinecone
          const embRes = await ai.models.embedContent({
              model: "text-embedding-004",
              contents: [{ parts: [{ text: extraction.substring(0, 8000) }] }]
          });
          // FIX: Access 'embeddings' instead of 'embedding'
          const vectorValues: number[] = embRes.embeddings?.[0]?.values || [];

          if (process.env.PINECONE_API_KEY && vectorValues.length > 0) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              const index = pc.index(process.env.PINECONE_INDEX_NAME!);
              // DO fix: Pinecone upsert format - Pass array directly
              await index.upsert([{
                  id: docId,
                  values: vectorValues,
                  metadata: { filename: fileName, text: extraction.substring(0, 1000) }
              }] as any);
          }
      });

      await updateDbStatus(docId, "Thành công (Indexed)");
    } catch (error: any) {
      await updateDbStatus(docId, error.message, true);
      throw error;
    }
  }
);

export default serve({
  client: inngest,
  functions: [processFileInBackground],
});
