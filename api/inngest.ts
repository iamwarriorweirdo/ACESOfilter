import { serve } from "inngest/node";
import { Inngest } from "inngest";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { Buffer } from 'node:buffer';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

// --- CONFIGURATION ---
export const inngest = new Inngest({ id: "hr-rag-app" });

// --- HELPERS ---
async function updateDbStatus(docId: string, message: string, isError = false) {
  const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!dbUrl) return;
  try {
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
    const timestamp = new Date().toLocaleTimeString('vi-VN');
    const safeMessage = message.substring(0, 200); 
    const logLine = `[${timestamp}] ${isError ? '❌' : '⚡'} ${safeMessage}`;
    
    if (isError) {
        await sql`UPDATE documents SET extracted_content = ${logLine}, status = 'failed' WHERE id = ${docId}`;
    } else {
        await sql`UPDATE documents SET status = ${safeMessage.substring(0, 50)} WHERE id = ${docId}`;
    }
  } catch (e) { console.error("DB Log Error:", e); }
}

async function getEmbeddingWithFallback(ai: GoogleGenAI, text: string, primaryModel: string = 'text-embedding-004'): Promise<number[]> {
    try {
        const res = await ai.models.embedContent({
            model: primaryModel,
            contents: { parts: [{ text }] }
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        return [];
    }
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp',
      txt: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  };
  return map[ext || ''] || 'application/octet-stream';
}

// --- CORE FUNCTION ---
const processFileInBackground = inngest.createFunction(
  { 
    id: "process-file-background", 
    retries: 0, // No retry for heavy tasks to save billing/resources
    concurrency: { limit: 1 } // Serial processing for safety
  },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, docId } = event.data;
    if (!url || !docId) return { error: "Missing Input" };

    try {
      // --- STEP 1: CONFIGURATION ---
      const configStep = await step.run("1-get-config", async () => {
         const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
         if (!dbUrl) return {};
         const { neon } = await import('@neondatabase/serverless');
         const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
         const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
         return rows.length > 0 ? JSON.parse(rows[0].data) : {};
      });

      const ingestionApiKey = process.env.OCR_API_KEY || configStep.ocrApiKey || process.env.API_KEY || "";
      if (!ingestionApiKey) throw new Error("Missing API Key for OCR");

      // --- STEP 2: CHECK FILE METADATA & STRATEGY ---
      const strategy = await step.run("2-check-strategy", async () => {
          await updateDbStatus(docId, `Kiểm tra kích thước file...`);
          try {
              const headRes = await fetch(url, { method: 'HEAD' });
              const size = Number(headRes.headers.get('content-length') || 0);
              // Threshold 10MB: > 10MB uses "Partial Indexing" via Stream
              return { size, isLarge: size > 10 * 1024 * 1024 }; 
          } catch (e) {
              return { size: 0, isLarge: true }; // Assume large if HEAD fails
          }
      });

      // --- STEP 3: PERFORM OCR (Partial or Full) ---
      const ocrResult = await step.run("3-smart-ocr", async () => {
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          const mimeType = getMimeType(fileName);

          // === CHIẾN LƯỢC CHO FILE LỚN (>= 10MB) ===
          if (strategy.isLarge) {
              await updateDbStatus(docId, `File lớn (${(strategy.size/1024/1024).toFixed(1)}MB). Dùng chế độ: Mục lục & Tóm tắt...`);
              
              const tempFilePath = path.join(os.tmpdir(), `partial_${docId}_${Date.now()}.${fileName.split('.').pop()}`);
              let googleFile: any = null;

              try {
                  // 1. STREAM DOWNLOAD (RAM Safe)
                  const response = await fetch(url);
                  if (!response.ok || !response.body) throw new Error("Download failed");
                  
                  // @ts-ignore: web stream to node stream
                  const nodeStream = Readable.fromWeb(response.body);
                  await pipeline(nodeStream, fs.createWriteStream(tempFilePath));
                  
                  // 2. UPLOAD TO GOOGLE (Storage Safe)
                  await updateDbStatus(docId, `Đang đẩy file sang AI Server...`);
                  const uploadResult = await genAI.files.upload({
                      file: tempFilePath,
                      config: { mimeType }
                  });
                  googleFile = uploadResult;

                  // 3. WAIT FOR PROCESSING
                  let fileState = googleFile.state;
                  while (fileState === "PROCESSING") {
                      await new Promise(r => setTimeout(r, 2000));
                      const freshFile = await genAI.files.get({ name: googleFile.name });
                      fileState = freshFile.state;
                  }
                  if (fileState === "FAILED") throw new Error("Google AI failed to process file.");

                  // 4. SMART PROMPT (Partial Extraction)
                  // Đây là phần quan trọng nhất: Yêu cầu AI chỉ đọc phần đầu và mục lục
                  await updateDbStatus(docId, `AI đang phân tích cấu trúc & mục lục...`);
                  const prompt = `Đây là một tài liệu rất lớn. ĐỪNG cố gắng đọc hết toàn bộ từng chữ.
                  Nhiệm vụ của bạn là tạo một bản tóm tắt metadata chất lượng cao để làm chỉ mục tìm kiếm (Index).
                  
                  Hãy trích xuất các thông tin sau:
                  1. Tiêu đề chính xác của tài liệu.
                  2. Mục lục (Table of Contents) hoặc danh sách các đề mục chính.
                  3. Tóm tắt nội dung của 5-10 trang đầu tiên (Introduction/Summary).
                  4. Các từ khóa quan trọng nhất.
                  
                  Trả về kết quả dưới dạng văn bản có cấu trúc rõ ràng.`;

                  const result = await genAI.models.generateContent({
                      model: "gemini-3-flash-preview",
                      contents: {
                          parts: [
                              { fileData: { fileUri: googleFile.uri, mimeType } },
                              { text: prompt }
                          ]
                      }
                  });

                  return { 
                      text: result.text || "", 
                      method: "gemini-partial-large-file",
                      isPartial: true
                  };

              } catch (e: any) {
                  throw new Error(`Large File Error: ${e.message}`);
              } finally {
                  try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
                  try { if (googleFile) await genAI.files.delete({ name: googleFile.name }); } catch (e) {}
              }
          } 
          
          // === CHIẾN LƯỢC CHO FILE NHỎ (< 10MB) ===
          else {
              await updateDbStatus(docId, `Tải tài liệu vào bộ nhớ (RAM Mode)...`);
              const res = await fetch(url);
              const arrayBuffer = await res.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const base64 = buffer.toString('base64');
              
              let text = "";
              let method = "unknown";
              const lowName = fileName.toLowerCase();

              // Thử parse bằng thư viện nhẹ trước để tiết kiệm
              try {
                  if (lowName.endsWith('.txt')) {
                      text = buffer.toString('utf-8');
                      method = "text-direct";
                  } else if (lowName.endsWith('.pdf')) {
                      try {
                          // @ts-ignore
                          const pdfParseModule = await import('pdf-parse');
                          const pdf = pdfParseModule.default || pdfParseModule;
                          const data = await pdf(buffer);
                          text = data.text;
                          method = "pdf-parse-local";
                      } catch (e) {}
                  }
              } catch (e) {}

              // Nếu thất bại hoặc ít chữ quá -> Dùng Vision AI
              if ((!text || text.length < 50)) {
                   await updateDbStatus(docId, `Dùng AI Vision đọc chi tiết...`);
                   const res = await genAI.models.generateContent({
                        model: "gemini-3-flash-preview",
                        contents: {
                            parts: [
                                { inlineData: { data: base64, mimeType } },
                                { text: "Trích xuất toàn bộ văn bản trong tài liệu này." }
                            ]
                        }
                    });
                    text = res.text || "";
                    method = "gemini-vision-buffer";
              }

              return { text: (text || "").substring(0, 80000), method, isPartial: false };
          }
      });

      // --- STEP 4: ANALYZE METADATA ---
      const metaResult = await step.run("4-analyze-metadata", async () => {
          if (!ocrResult.text) return { title: fileName, summary: "Lỗi đọc nội dung." };
          
          await updateDbStatus(docId, `Đang chuẩn hóa dữ liệu...`);
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          
          try {
              // Nếu là file partial, text đã là tóm tắt rồi, nên context lấy ít hơn
              const context = ocrResult.text.substring(0, 10000);
              const prompt = `Phân tích văn bản sau và trả về JSON thuần: { "title": "Tiêu đề ngắn", "summary": "Tóm tắt 2 dòng", "language": "vi/en", "key_information": ["gạch đầu dòng 1", "gạch đầu dòng 2"] }. Văn bản: ${context}`;
              
              const res = await genAI.models.generateContent({
                  model: "gemini-3-flash-preview",
                  contents: prompt,
                  config: { responseMimeType: "application/json" }
              });
              return JSON.parse(res.text || "{}");
          } catch (e) {
              return { title: fileName, summary: "AI Analysis Failed" };
          }
      });

      // --- STEP 5: SAVE TO DB ---
      await step.run("5-save-db", async () => {
          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const finalContent = {
              ...metaResult,
              full_text_content: ocrResult.text, 
              parse_method: ocrResult.method,
              is_partial_index: ocrResult.isPartial // Flag để Frontend hiển thị cảnh báo nếu cần
          };
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(finalContent)}, status = ${ocrResult.isPartial ? 'indexed_partial' : 'indexed'} WHERE id = ${docId}`;
      });

      // --- STEP 6: VECTORIZE ---
      await step.run("6-vectorize", async () => {
          if (!ocrResult.text || ocrResult.text.length < 10) return;
          await updateDbStatus(docId, `Đang tạo Vector (Search Index)...`);
          
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          // Với partial index, nội dung text chính là summary/TOC nên rất tốt cho semantic search
          const vector = await getEmbeddingWithFallback(genAI, ocrResult.text.substring(0, 8000));
          
          if (vector.length > 0 && process.env.PINECONE_API_KEY) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              const index = pc.index(process.env.PINECONE_INDEX_NAME!);
              
              await index.upsert([{
                  id: docId,
                  values: vector,
                  metadata: {
                      filename: fileName,
                      text: ocrResult.text.substring(0, 4000)
                  }
              }] as any);
              await updateDbStatus(docId, `Hoàn tất.`);
          }
      });

      return { success: true };

    } catch (e: any) {
        await updateDbStatus(docId, `Lỗi: ${e.message}`, true);
        throw e;
    }
  }
);

// Keep cleanup functions
const deleteFileInBackground = inngest.createFunction(
    { id: "delete-file-background" },
    { event: "app/delete.file" },
    async ({ event, step }) => {
        const { docId } = event.data;
        await step.run("delete-pinecone", async () => {
             if (process.env.PINECONE_API_KEY) {
                 try {
                     const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                     await pc.index(process.env.PINECONE_INDEX_NAME!).deleteMany([docId]);
                 } catch (e) { }
             }
        });
        return { deleted: docId };
    }
);

const syncDatabaseBackground = inngest.createFunction(
    { id: "sync-database-background" },
    { event: "app/sync.database" },
    async ({ event }) => { return { status: "synced" }; }
);

export default serve({ client: inngest, functions: [processFileInBackground, deleteFileInBackground, syncDatabaseBackground] });