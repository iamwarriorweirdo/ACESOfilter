
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
  let targetUrl = url.replace('http://', 'https://').trim();
  const res = await fetch(targetUrl, { headers });
  if (!res.ok) throw new Error(`Lỗi tải tệp: ${res.status}`);
  return await res.arrayBuffer();
}

async function updateDbStatus(docId: string, message: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const logLine = `[${timestamp}] ${isError ? '❌ ERROR' : 'ℹ️ INFO'}: ${message}`;
    if (isError) {
        await sql`UPDATE documents SET extracted_content = ${logLine}, status = 'failed' WHERE id = ${docId}`;
    } else {
        await sql`UPDATE documents SET extracted_content = ${logLine} WHERE id = ${docId}`;
    }
  } catch (e) { }
}

async function getHFEmbedding(text: string) {
    const hfKey = process.env.HUGGING_FACE_API_KEY;
    if (!hfKey) return null;
    try {
        const response = await fetch("https://api-inference.huggingface.co/models/sentence-transformers/all-MiniLM-L6-v2", {
            headers: { Authorization: `Bearer ${hfKey}`, "Content-Type": "application/json" },
            method: "POST",
            body: JSON.stringify({ inputs: text.substring(0, 512) }),
        });
        return await response.json();
    } catch (e) { return null; }
}

async function extractDocxRawTextFallback(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return "";
    const textMatches = docXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
    if (!textMatches) return "";
    return textMatches.map(val => val.replace(/<[^>]+>/g, '')).join(' ');
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
        const lowName = fileName.toLowerCase();
        let text = "";
        let method = "unknown";

        if (lowName.endsWith('.txt')) {
          text = buffer.toString('utf-8');
          method = "text-plain";
        } else if (lowName.endsWith('.docx')) {
          try {
            const mammoth = await import('mammoth');
            const extractor = mammoth.default || mammoth;
            const res = await extractor.extractRawText({ buffer });
            text = res.value;
            method = "docx-mammoth";
          } catch (e) {
            text = await extractDocxRawTextFallback(buffer);
            method = "docx-jszip";
          }
        } else if (lowName.endsWith('.pdf')) {
          const pdfParse = await import('pdf-parse');
          const pdfExtractor = pdfParse.default || pdfParse;
          const data = await pdfExtractor(buffer);
          text = data.text;
          method = "pdf-parse";
        }
        return { text, method, bufferBase64: buffer.toString('base64') };
      });

      const finalResult = await step.run("ocr-and-failover", async () => {
        let text = parseResult.text;
        let method = parseResult.method;

        if (!text || text.trim().length < 5) {
          try {
            await updateDbStatus(docId, "Sử dụng Gemini Vision OCR...");
            const res = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [{ role: 'user', parts: [
                { inlineData: { data: parseResult.bufferBase64, mimeType: 'application/octet-stream' } },
                { text: "Trích xuất toàn bộ văn bản từ tài liệu này." }
              ]}]
            });
            text = res.text || "";
            method = "gemini-ocr-vision";
          } catch (e) {
            throw new Error("OCR Thất bại.");
          }
        }
        return { text, method };
      });

      await step.run("indexing", async () => {
          let meta = { title: fileName, summary: "Tài liệu", key_information: [], language: "vi" };
          try {
             const res = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: [{ role: 'user', parts: [{ text: `Trả về JSON {title, summary, key_information, language} cho: ${finalResult.text.substring(0, 3000)}` }] }],
                config: { responseMimeType: 'application/json' }
             });
             meta = JSON.parse(res.text || "{}");
          } catch (e) {
             try {
                const groqRes = await groq.chat.completions.create({
                    messages: [{ role: "user", content: `JSON metadata cho văn bản: ${finalResult.text.substring(0, 3000)}` }],
                    model: "llama-3.1-70b-versatile",
                    response_format: { type: "json_object" }
                });
                meta = JSON.parse(groqRes.choices[0]?.message?.content || "{}");
             } catch (ge) {}
          }

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify({ ...meta, full_text_content: finalResult.text, parse_method: finalResult.method })}, status = 'completed' WHERE id = ${docId}`;

          // Vector Indexing
          try {
              const emb = await ai.models.embedContent({
                  model: "text-embedding-004",
                  contents: [{ parts: [{ text: finalResult.text.substring(0, 3000) }] }]
              });
              const vector = emb.embeddings?.[0]?.values || [];
              if (vector.length > 0 && process.env.PINECONE_API_KEY) {
                  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                  await pc.index(process.env.PINECONE_INDEX_NAME!).upsert([{ id: docId, values: vector, metadata: { filename: fileName, text: finalResult.text.substring(0, 4000) } }] as any);
              }
          } catch (e) {
              await updateDbStatus(docId, "Hoàn tất (Vector Search dự phòng HF chưa kích hoạt).");
          }
      });
    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
    }
  }
);

export default serve({ client: inngest, functions: [processFileInBackground] });
