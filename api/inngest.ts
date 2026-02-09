
import { serve } from "inngest/node";
import { Inngest } from "inngest";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import Groq from "groq-sdk";
import { Buffer } from 'node:buffer';
import JSZip from 'jszip';

export const inngest = new Inngest({ id: "hr-rag-app" });

async function fetchFileBuffer(url: string) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  let res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  return await res.arrayBuffer();
}

async function updateDbStatus(docId: string, message: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return;
  try {
    // @ts-ignore
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    const timestamp = new Date().toLocaleTimeString();
    const logLine = `[${timestamp}] ${isError ? '❌ ERROR' : 'ℹ️ INFO'}: ${message}`;
    if (isError) await sql`UPDATE documents SET extracted_content = ${logLine}, status = 'failed' WHERE id = ${docId}`;
    else await sql`UPDATE documents SET extracted_content = ${logLine} WHERE id = ${docId}`;
  } catch (e) { }
}

async function extractDocxRawText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    return (docXml?.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || []).map(val => val.replace(/<[^>]+>/g, '')).join(' ');
  } catch (e) { return ""; }
}

const processFileInBackground = inngest.createFunction(
  { id: "process-file-background", retries: 0 },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, docId } = event.data;
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });

    try {
      const parseResult = await step.run("extract-text", async () => {
        await updateDbStatus(docId, `Bắt đầu xử lý: ${fileName}`);
        const ab = await fetchFileBuffer(url);
        const buffer = Buffer.from(ab);
        let text = "", method = "unknown";

        if (fileName.toLowerCase().endsWith('.docx')) {
          // @ts-ignore
          const mammoth = await import('mammoth');
          const mamRes = await mammoth.extractRawText({ buffer });
          text = mamRes.value || await extractDocxRawText(buffer);
          method = "docx-parser";
        } else if (fileName.toLowerCase().endsWith('.pdf')) {
          // @ts-ignore
          const pdfParse = await import('pdf-parse');
          const data = await pdfParse.default(buffer);
          text = data.text;
          method = "pdf-parse";
        }
        return { text, method, bufferBase64: buffer.toString('base64') };
      });

      const finalResult = await step.run("ocr-analysis-failover", async () => {
        let text = parseResult.text;
        let method = parseResult.method;

        if (!text || text.trim().length < 20) {
          try {
            await updateDbStatus(docId, "Sử dụng Gemini Vision OCR...");
            const res = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [{ role: 'user', parts: [
                { inlineData: { data: parseResult.bufferBase64, mimeType: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png' } },
                { text: "Extract text." }
              ]}]
            });
            text = res.text || "";
            method = "gemini-ocr";
          } catch (e: any) {
            await updateDbStatus(docId, "Gemini OCR lỗi. Thử dùng Groq Llama-3 để phục hồi văn bản thô (nếu có)...", true);
            // Groq fallback chỉ dùng cho Text analysis, không làm được OCR ảnh scan
            if (parseResult.text) {
                const groqRes = await groq.chat.completions.create({
                    messages: [{ role: "user", content: `Làm sạch và sửa lỗi chính tả cho văn bản trích xuất thô này: ${parseResult.text.substring(0, 10000)}` }],
                    model: "llama-3.1-70b-versatile"
                });
                text = groqRes.choices[0]?.message?.content || parseResult.text;
                method = "groq-cleanup";
            } else {
                throw new Error("Gemini OCR hết quota và không có dữ liệu văn bản thô để fallback.");
            }
          }
        }
        return { text, method };
      });

      await step.run("metadata-failover", async () => {
          await updateDbStatus(docId, "Phân tích Metadata...");
          let meta;
          try {
            const res = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [{ role: 'user', parts: [{ text: `JSON: ${finalResult.text.substring(0, 10000)}` }] }],
              config: { responseMimeType: 'application/json' }
            });
            meta = JSON.parse(res.text || "{}");
          } catch (e) {
            const groqRes = await groq.chat.completions.create({
                messages: [{ role: "user", content: `Trả về JSON {title, summary, key_information: [], language}: ${finalResult.text.substring(0, 5000)}` }],
                model: "llama-3.1-70b-versatile",
                response_format: { type: "json_object" }
            });
            meta = JSON.parse(groqRes.choices[0]?.message?.content || "{}");
          }

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify({ ...meta, full_text_content: finalResult.text, parse_method: finalResult.method })}, status = 'completed' WHERE id = ${docId}`;

          const emb = await ai.models.embedContent({ model: "text-embedding-004", contents: [{ parts: [{ text: finalResult.text.substring(0, 3000) }] }] });
          const vector = emb.embeddings?.[0]?.values || [];
          if (vector.length > 0 && process.env.PINECONE_API_KEY) {
            const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
            await pc.index(process.env.PINECONE_INDEX_NAME!).upsert([{ id: docId, values: vector, metadata: { filename: fileName, text: finalResult.text.substring(0, 4000) } }] as any);
          }
      });
    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
    }
  }
);
export default serve({ client: inngest, functions: [processFileInBackground] });
