
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
  // Đảm bảo URL luôn là https và không có khoảng trắng thừa
  let targetUrl = url.replace('http://', 'https://').trim();
  const res = await fetch(targetUrl, { headers });
  if (!res.ok) throw new Error(`Không thể tải tệp từ Cloudinary/Storage (Mã lỗi: ${res.status})`);
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

/**
 * Bộ trích xuất "cứu cánh" dùng JSZip để đọc trực tiếp XML của Word
 */
async function extractDocxRawTextFallback(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const docXml = await zip.file("word/document.xml")?.async("string");
    if (!docXml) return "";

    // Xóa bỏ tất cả các thẻ XML, chỉ giữ lại nội dung bên trong <w:t>
    // Regex này mạnh hơn: lấy nội dung giữa các thẻ <w:t>...</w:t>
    const textMatches = docXml.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
    if (!textMatches) return "";

    return textMatches
      .map(val => val.replace(/<[^>]+>/g, '')) // Xóa thẻ
      .map(val => val.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')) // Decode entities
      .join(' ');
  } catch (e) { 
    return ""; 
  }
}

const processFileInBackground = inngest.createFunction(
  { id: "process-file-background", retries: 0 },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, docId } = event.data;
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });

    try {
      // --- BƯỚC 1: TRÍCH XUẤT VĂN BẢN THÔ ---
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
          await updateDbStatus(docId, "Đang trích xuất bằng Mammoth...");
          
          try {
            // @ts-ignore
            const mammoth = await import('mammoth');
            // Xử lý import mammoth trong môi trường Vercel (đôi khi nằm trong .default)
            const extractor = mammoth.default || mammoth;
            const mamRes = await extractor.extractRawText({ buffer });
            text = mamRes.value || "";
            method = "docx-mammoth";
            
            if (mamRes.messages && mamRes.messages.length > 0) {
                console.warn("Mammoth warnings:", mamRes.messages);
            }
          } catch (e: any) {
            await updateDbStatus(docId, `Mammoth bị lỗi hệ thống: ${e.message}. Chuyển sang JSZip...`);
          }

          // Kiểm tra nếu Mammoth không lấy được chữ nào
          if (!text || text.trim().length < 5) {
            await updateDbStatus(docId, "Mammoth không tìm thấy văn bản. Đang thử giải mã cấu trúc XML trực tiếp...");
            text = await extractDocxRawTextFallback(buffer);
            method = "docx-jszip-xml";
          }
        } else if (lowName.endsWith('.pdf')) {
          await updateDbStatus(docId, "Đang phân tích cấu trúc PDF...");
          try {
            // @ts-ignore
            const pdfParse = await import('pdf-parse');
            const pdfExtractor = pdfParse.default || pdfParse;
            const data = await pdfExtractor(buffer);
            text = data.text;
            method = "pdf-parse";
          } catch (e: any) {
             await updateDbStatus(docId, `PDF Parser lỗi: ${e.message}`);
          }
        }

        return { text, method, bufferBase64: buffer.toString('base64') };
      });

      // --- BƯỚC 2: OCR VÀ XỬ LÝ FAILOVER (AI) ---
      const finalResult = await step.run("ocr-and-failover", async () => {
        let text = parseResult.text;
        let method = parseResult.method;

        // Nếu cả Mammoth và JSZip đều thất bại trong việc tìm văn bản
        if (!text || text.trim().length < 5) {
          try {
            await updateDbStatus(docId, "Văn bản thô rỗng (có thể là file scan/ảnh). Đang gọi Gemini Vision OCR...");
            const res = await ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: [{ role: 'user', parts: [
                { inlineData: { data: parseResult.bufferBase64, mimeType: fileName.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' } },
                { text: "Đây là một tài liệu văn bản. Hãy trích xuất toàn bộ nội dung chữ trong tệp này một cách chính xác nhất có thể." }
              ]}]
            });
            text = res.text || "";
            method = "gemini-ocr-vision";
          } catch (e: any) {
            // Lỗi Quota 429 hoặc lỗi AI
            const isQuota = e.message?.includes('429') || e.message?.includes('quota');
            const errorMsg = isQuota ? "Gemini OCR Hết Quota (Lượt dùng miễn phí)" : `AI Error: ${e.message}`;
            throw new Error(`${errorMsg}. Không có dữ liệu thô để phục hồi.`);
          }
        } else {
            await updateDbStatus(docId, `Trích xuất thành công bằng ${method} (${text.length} ký tự).`);
        }

        return { text, method };
      });

      // --- BƯỚC 3: LƯU TRỮ VÀ INDEX ---
      await step.run("indexing", async () => {
          await updateDbStatus(docId, "Đang phân tích ngữ nghĩa và tạo chỉ mục...");
          
          let meta = { title: fileName, summary: "Tài liệu văn bản", key_information: [], language: "vi" };
          try {
             // Thử dùng Gemini để lấy metadata
             const res = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: [{ role: 'user', parts: [{ text: `Hãy phân tích văn bản sau và trả về JSON {title, summary, key_information: string[], language}: ${finalResult.text.substring(0, 5000)}` }] }],
                config: { responseMimeType: 'application/json' }
             });
             meta = JSON.parse(res.text || "{}");
          } catch (e) {
             // Nếu Gemini hết lượt, thử dùng Groq để lấy Metadata (vì bước này chỉ cần text)
             try {
                 if (process.env.GROQ_API_KEY) {
                     await updateDbStatus(docId, "Gemini bận, đang dùng Llama-3 để phân tích Metadata...");
                     const groqRes = await groq.chat.completions.create({
                        messages: [{ role: "user", content: `Trả về JSON {title, summary, key_information, language} cho văn bản này: ${finalResult.text.substring(0, 4000)}` }],
                        model: "llama-3.1-70b-versatile",
                        response_format: { type: "json_object" }
                     });
                     meta = JSON.parse(groqRes.choices[0]?.message?.content || "{}");
                 }
             } catch (ge) { }
          }

          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          // @ts-ignore
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const fullData = { ...meta, full_text_content: finalResult.text, parse_method: finalResult.method };
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(fullData)}, status = 'completed' WHERE id = ${docId}`;

          // Embedding cho Pinecone (Chỉ làm nếu Gemini còn lượt)
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
          } catch (e) {
              await updateDbStatus(docId, "Hoàn tất nhưng không thể tạo Vector Search (Hết quota Embedding).");
          }
      });

    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
    }
  }
);

export default serve({ client: inngest, functions: [processFileInBackground] });
