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
import * as mammoth from 'mammoth';
import * as XLSX from 'xlsx';

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

async function getEmbeddingWithFallback(ai: GoogleGenAI, text: string, primaryModel: string = 'embedding-001'): Promise<number[]> {
    try {
        const res = await ai.models.embedContent({
            model: "embedding-001",
            contents: { parts: [{ text }] }
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error("Embedding failed:", e.message);
        return [];
    }
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
      txt: 'text/plain',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      csv: 'text/csv',
      md: 'text/md',
      html: 'text/html',
      xml: 'text/xml',
      rtf: 'text/rtf',
      py: 'text/x-python',
      js: 'text/javascript',
      ts: 'text/javascript'
  };
  return map[ext || ''] || 'application/octet-stream';
}

function isGeminiFileSupported(mimeType: string): boolean {
    const supported = [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/html', 'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf',
        'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'
    ];
    return supported.includes(mimeType) || mimeType.startsWith('image/');
}

// --- CORE FUNCTION ---
const processFileInBackground = inngest.createFunction(
  { 
    id: "process-file-background", 
    retries: 0, 
    concurrency: { limit: 1 }
  },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, docId } = event.data;
    if (!url || !docId) return { error: "Missing Input" };

    try {
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

      const strategy = await step.run("2-check-strategy", async () => {
          await updateDbStatus(docId, `Kiểm tra kích thước file...`);
          try {
              const headRes = await fetch(url, { method: 'HEAD' });
              const size = Number(headRes.headers.get('content-length') || 0);
              return { size, isLarge: size > 10 * 1024 * 1024 }; 
          } catch (e) {
              return { size: 0, isLarge: true };
          }
      });

      const ocrResult = await step.run("3-smart-ocr", async () => {
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          const mimeType = getMimeType(fileName);
          const isSupported = isGeminiFileSupported(mimeType);

          // Chọn model OCR dựa trên config hoặc auto
          let ocrModel = configStep.ocrModel || 'auto';
          if (ocrModel === 'auto') {
              ocrModel = 'gemini-3-flash-preview';
          }

          if (strategy.isLarge) {
              await updateDbStatus(docId, `File lớn. Đang tải Stream...`);
              const tempFilePath = path.join(os.tmpdir(), `partial_${docId}_${Date.now()}.${fileName.split('.').pop()}`);
              
              try {
                  const response = await fetch(url);
                  if (!response.ok || !response.body) throw new Error("Download failed");
                  const nodeStream = Readable.fromWeb(response.body as any);
                  await pipeline(nodeStream, fs.createWriteStream(tempFilePath));

                  if (isSupported) {
                      let googleFile: any = null;
                      try {
                          await updateDbStatus(docId, `Đẩy file sang Google AI...`);
                          const uploadResult = await genAI.files.upload({
                              file: tempFilePath,
                              config: { mimeType }
                          });
                          googleFile = uploadResult;

                          let fileState = googleFile.state;
                          while (fileState === "PROCESSING") {
                              await new Promise(r => setTimeout(r, 2000));
                              const freshFile = await genAI.files.get({ name: googleFile.name });
                              fileState = freshFile.state;
                          }
                          
                          await updateDbStatus(docId, `AI đang phân tích...`);
                          const result = await genAI.models.generateContent({
                              model: ocrModel,
                              contents: {
                                  parts: [
                                      { fileData: { fileUri: googleFile.uri, mimeType } },
                                      { text: "Trích xuất toàn bộ nội dung văn bản quan trọng từ tài liệu này để làm chỉ mục tìm kiếm." }
                                  ]
                              }
                          });

                          return { text: result.text || "", method: `gemini-file-api-${ocrModel}`, isPartial: true };
                      } finally {
                          try { if (googleFile) await genAI.files.delete({ name: googleFile.name }); } catch (e) {}
                      }
                  } else {
                      // Xử lý local cho Docx/Xlsx
                      let text = "";
                      if (fileName.endsWith('.docx')) {
                           const result = await mammoth.extractRawText({ path: tempFilePath });
                           text = result.value;
                      } else if (fileName.endsWith('.xlsx')) {
                           const workbook = XLSX.readFile(tempFilePath);
                           text = XLSX.utils.sheet_to_txt(workbook.Sheets[workbook.SheetNames[0]]);
                      }
                      return { text: text.substring(0, 50000), method: "local-extract", isPartial: true };
                  }
              } finally {
                  try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
              }
          } else {
              // Xử lý file nhỏ trong RAM
              const res = await fetch(url);
              const buffer = Buffer.from(await res.arrayBuffer());
              const base64 = buffer.toString('base64');
              
              let text = "";
              if (isSupported) {
                   await updateDbStatus(docId, `AI đang quét nội dung...`);
                   const resAi = await genAI.models.generateContent({
                        model: ocrModel,
                        contents: {
                            parts: [
                                { inlineData: { data: base64, mimeType } },
                                { text: "Trích xuất nội dung văn bản chính." }
                            ]
                        }
                    });
                    text = resAi.text || "";
              }
              return { text: text.substring(0, 80000), method: ocrModel, isPartial: false };
          }
      });

      const metaResult = await step.run("4-analyze-metadata", async () => {
          if (!ocrResult.text) return { title: fileName, summary: "Lỗi đọc nội dung." };
          await updateDbStatus(docId, `AI đang chuẩn hóa Index...`);
          
          let analysisModel = configStep.analysisModel || 'auto';
          if (analysisModel === 'auto') analysisModel = 'gemini-3-flash-preview';

          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          try {
              const res = await genAI.models.generateContent({
                  model: analysisModel,
                  contents: `Phân tích dữ liệu sau và trả về JSON: { "title": "Tiêu đề", "summary": "Tóm tắt ngắn", "language": "vi/en", "key_information": ["ý chính 1", "ý chính 2"] }. Dữ liệu: ${ocrResult.text.substring(0, 10000)}`,
                  config: { responseMimeType: "application/json" }
              });
              return JSON.parse(res.text || "{}");
          } catch (e) {
              return { title: fileName, summary: "AI Analysis Failed" };
          }
      });

      await step.run("5-save-db", async () => {
          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const finalContent = {
              ...metaResult,
              full_text_content: ocrResult.text, 
              parse_method: ocrResult.method,
              is_partial_index: ocrResult.isPartial 
          };
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(finalContent)}, status = 'indexed' WHERE id = ${docId}`;
      });

      await step.run("6-vectorize", async () => {
          if (!ocrResult.text || ocrResult.text.length < 10) return;
          await updateDbStatus(docId, `Tạo Search Vector...`);
          
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          const embeddingModel = configStep.embeddingModel || 'embedding-001';
          const vector = await getEmbeddingWithFallback(genAI, ocrResult.text.substring(0, 8000), embeddingModel);
          
          if (vector.length > 0 && process.env.PINECONE_API_KEY) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              const index = pc.index(process.env.PINECONE_INDEX_NAME!);
              await index.upsert([{
                  id: docId,
                  values: vector,
                  metadata: { filename: fileName, text: ocrResult.text.substring(0, 4000) }
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

export default serve({ client: inngest, functions: [processFileInBackground, deleteFileInBackground] });