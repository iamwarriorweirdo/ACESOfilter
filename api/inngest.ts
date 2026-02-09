
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
  let targetUrl = url.replace('http://', 'https://');
  let res = await fetch(targetUrl, { headers });
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
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const logLine = `[${timestamp}] ${isError ? '❌ ERROR' : 'ℹ️ INFO'}: ${message}`;
    
    // Nếu là lỗi, đánh dấu status failed. Nếu là info, chỉ cập nhật log.
    if (isError) {
        await sql`UPDATE documents SET extracted_content = ${logLine}, status = 'failed' WHERE id = ${docId}`;
    } else {
        await sql`UPDATE documents SET extracted_content = ${logLine} WHERE id = ${docId}`;
    }
  } catch (e) { }
}

async function extractDocxRawText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return "";
    return (docXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g) || []).map(val => val.replace(/<[^>]+>/g, '')).join(' ');
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
      // --- BƯỚC 1: TRÍCH XUẤT VĂN BẢN THÔ (Dùng thư viện nội bộ, không tốn AI Quota) ---
      const parseResult = await step.run("extract-text", async () => {
        await updateDbStatus(docId, `Bắt đầu xử lý tệp: ${fileName}`);
        const ab = await fetchFileBuffer(url);
        const buffer = Buffer.from(ab);
        const lowName = fileName.toLowerCase();
        
        let text = "";
        let method = "unknown";

        if (lowName.endsWith('.txt')) {
          await updateDbStatus(docId, "Đang đọc tệp văn bản thô (.txt)...");
          text = buffer.toString('utf-8');
          method = "text-plain-reader";
        } else if (lowName.endsWith('.docx')) {
          await updateDbStatus(docId, "Đang trích xuất Word/WPS (Mammoth)...");
          // @ts-ignore
          const mammoth = await import('mammoth');
          try {
            const mamRes = await mammoth.extractRawText({ buffer });
            text = mamRes.value;
            method = "docx-mammoth";
          } catch (e) { }

          if (!text || text.trim().length < 10) {
            await updateDbStatus(docId, "Mammoth thất bại, dùng bộ giải mã JSZip XML...");
            text = await extractDocxRawText(buffer);
            method = "docx-jszip-xml";
          }
        } else if (lowName.endsWith('.pdf')) {
          await updateDbStatus(docId, "Đang phân tích cấu trúc PDF...");
          // @ts-ignore
          const pdfParse = await import('pdf-parse');
          const data = await pdfParse.default(buffer);
          text = data.text;
          method = "pdf-parse";
        }

        return { text, method, bufferBase64: buffer.toString('base64') };
      });

      // --- BƯỚC 2: OCR VÀ XỬ LÝ FAILOVER (Dùng AI) ---
      const finalResult = await step.run("ocr-and-failover", async () => {
        let text = parseResult.text;
        let method = parseResult.method;

        // Nếu bước 1 không lấy được gì (ví dụ file PDF scan hoặc Word rỗng)
        if (!text || text.trim().length < 5) {
          try {
            await updateDbStatus(docId, "Dữ liệu thô rỗng. Đang gọi Gemini Vision OCR...");
            const res = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [{ role: 'user', parts: [
                { inlineData: { data: parseResult.bufferBase64, mimeType: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png' } },
                { text: "Extract all text from this document accurately." }
              ]}]
            });
            text = res.text || "";
            method = "gemini-ocr-vision";
          } catch (e: any) {
            // Nếu cả Gemini OCR cũng chết (hết lượt), ta đầu hàng vì không còn dữ liệu để xử lý
            throw new Error(`Gemini OCR thất bại (${e.message}) và không có văn bản thô để dự phòng.`);
          }
        } else if (method === "text-plain-reader" || method === "docx-jszip-xml") {
            // Nếu lấy được văn bản nhưng là văn bản thô chưa đẹp, dùng Groq dọn dẹp (nếu có key)
            try {
                if (process.env.GROQ_API_KEY) {
                    await updateDbStatus(docId, "Đang dùng Groq để làm đẹp văn bản...");
                    const groqRes = await groq.chat.completions.create({
                        messages: [{ role: "user", content: `Sửa lỗi định dạng và làm sạch văn bản sau: ${text.substring(0, 8000)}` }],
                        model: "llama-3.1-70b-versatile"
                    });
                    text = groqRes.choices[0]?.message?.content || text;
                    method += "+groq-clean";
                }
            } catch (e) { }
        }

        return { text, method };
      });

      // --- BƯỚC 3: LƯU TRỮ VÀ INDEX ---
      await step.run("indexing", async () => {
          await updateDbStatus(docId, "Đang tạo chỉ mục tìm kiếm...");
          
          let meta = { title: fileName, summary: "Tài liệu văn bản thô", key_information: [], language: "vi" };
          try {
             const res = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: [{ role: 'user', parts: [{ text: `Analyze and return JSON: ${finalResult.text.substring(0, 5000)}` }] }],
                config: { responseMimeType: 'application/json' }
             });
             meta = JSON.parse(res.text || "{}");
          } catch (e) { }

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const fullData = { ...meta, full_text_content: finalResult.text, parse_method: finalResult.method };
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullData)}, status = 'completed' WHERE id = ${docId}`;

          // Embedding cho Pinecone
          try {
              const emb = await ai.models.embedContent({
                  model: "text-embedding-004",
                  contents: [{ parts: [{ text: finalResult.text.substring(0, 3000) }] }]
              });
              const vector = emb.embeddings?.[0]?.values || [];
              if (vector.length > 0 && process.env.PINECONE_API_KEY) {
                  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                  await pc.index(process.env.PINECONE_INDEX_NAME!).upsert([{
                      id: docId,
                      values: vector,
                      metadata: { filename: fileName, text: finalResult.text.substring(0, 4000) }
                  }] as any);
              }
          } catch (e) { }
      });

    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
    }
  }
);

export default serve({ client: inngest, functions: [processFileInBackground] });
