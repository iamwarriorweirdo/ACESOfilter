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
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain', 'text/html', 'text/css', 'text/md', 'text/csv', 'text/xml', 'text/rtf',
        'application/x-javascript', 'text/javascript', 'application/x-python', 'text/x-python',
        'image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif',
        'audio/wav', 'audio/mp3', 'audio/aiff', 'audio/aac', 'audio/ogg', 'audio/flac',
        'video/mp4', 'video/mpeg', 'video/mov', 'video/avi', 'video/x-flv', 'video/mpg', 'video/webm', 'video/wmv', 'video/3gpp'
    ];
    return supported.includes(mimeType) || mimeType.startsWith('image/') || mimeType.startsWith('video/') || mimeType.startsWith('audio/');
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

          if (strategy.isLarge) {
              await updateDbStatus(docId, `File lớn (${(strategy.size/1024/1024).toFixed(1)}MB). Đang tải Stream...`);
              
              const tempFilePath = path.join(os.tmpdir(), `partial_${docId}_${Date.now()}.${fileName.split('.').pop()}`);
              
              try {
                  const response = await fetch(url);
                  if (!response.ok || !response.body) throw new Error("Download failed");
                  // @ts-ignore
                  const nodeStream = Readable.fromWeb(response.body);
                  await pipeline(nodeStream, fs.createWriteStream(tempFilePath));

                  if (isSupported) {
                      let googleFile: any = null;
                      try {
                          await updateDbStatus(docId, `Đang đẩy file sang Google AI Server...`);
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
                          if (fileState === "FAILED") throw new Error("Google AI failed to process file.");

                          await updateDbStatus(docId, `AI đang phân tích bài thuyết trình...`);
                          const prompt = `Đây là một tài liệu lớn. ĐỪNG cố gắng đọc hết toàn bộ từng chữ.
                          Nhiệm vụ của bạn là tạo một bản tóm tắt metadata chất lượng cao để làm chỉ mục tìm kiếm (Index).
                          Trích xuất: 1. Tiêu đề chính. 2. Các ý chính của từng slide quan trọng. 3. Tóm tắt nội dung cốt lõi. 4. Từ khóa liên quan. Trả về JSON theo cấu trúc yêu cầu.`;

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
                              method: "gemini-file-api-large",
                              isPartial: true
                          };
                      } finally {
                          try { if (googleFile) await genAI.files.delete({ name: googleFile.name }); } catch (e) {}
                      }
                  } else {
                      await updateDbStatus(docId, `Định dạng ${mimeType} xử lý cục bộ giới hạn...`);
                      let text = "";
                      try {
                          if (mimeType.includes('wordprocessingml') || fileName.endsWith('.docx')) {
                               const result = await mammoth.extractRawText({ path: tempFilePath });
                               text = result.value;
                          } else if (mimeType.includes('spreadsheet') || fileName.endsWith('.xlsx')) {
                               const workbook = XLSX.readFile(tempFilePath);
                               const sheetName = workbook.SheetNames[0];
                               text = XLSX.utils.sheet_to_txt(workbook.Sheets[sheetName]);
                          } else {
                               text = fs.readFileSync(tempFilePath, 'utf-8');
                          }
                      } catch(e: any) {
                          throw new Error(`Local extraction failed for ${fileName}: ${e.message}`);
                      }

                      const safeText = (text || "").substring(0, 50000);
                      return {
                          text: `[PARTIAL LOCAL EXTRACT]\n${safeText}`,
                          method: "local-disk-extract",
                          isPartial: true
                      };
                  }
              } catch (e: any) {
                  throw new Error(`Large File Error: ${e.message}`);
              } finally {
                  try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
              }
          } 
          else {
              await updateDbStatus(docId, `Tải tài liệu vào bộ nhớ RAM...`);
              const res = await fetch(url);
              const arrayBuffer = await res.arrayBuffer();
              const buffer = Buffer.from(arrayBuffer);
              const base64 = buffer.toString('base64');
              
              let text = "";
              let method = "unknown";
              const lowName = fileName.toLowerCase();

              try {
                  if (lowName.endsWith('.txt') || lowName.endsWith('.md') || lowName.endsWith('.csv')) {
                      text = buffer.toString('utf-8');
                      method = "text-direct";
                  } else if (lowName.endsWith('.pdf')) {
                      try {
                          const pdfParseModule = await import('pdf-parse');
                          const pdf = pdfParseModule.default || pdfParseModule;
                          const data = await pdf(buffer);
                          text = data.text;
                          method = "pdf-parse-local";
                      } catch (e) {}
                  } else if (lowName.endsWith('.docx')) {
                      const result = await mammoth.extractRawText({ buffer: buffer });
                      text = result.value;
                      method = "mammoth-docx-buffer";
                  } else if (lowName.endsWith('.xlsx') || lowName.endsWith('.xls')) {
                      const workbook = XLSX.read(buffer, { type: 'buffer' });
                      const sheetName = workbook.SheetNames[0];
                      text = XLSX.utils.sheet_to_txt(workbook.Sheets[sheetName]);
                      method = "xlsx-buffer";
                  }
              } catch (e) { }

              if ((!text || text.length < 50) && isSupported) {
                   await updateDbStatus(docId, `AI Vision đang quét nội dung...`);
                   const res = await genAI.models.generateContent({
                        model: "gemini-3-flash-preview",
                        contents: {
                            parts: [
                                { inlineData: { data: base64, mimeType } },
                                { text: "Phân tích và trích xuất nội dung văn bản chính từ tài liệu này." }
                            ]
                        }
                    });
                    text = res.text || "";
                    method = "gemini-vision-buffer";
              }

              return { text: (text || "").substring(0, 80000), method, isPartial: false };
          }
      });

      const metaResult = await step.run("4-analyze-metadata", async () => {
          if (!ocrResult.text) return { title: fileName, summary: "Lỗi đọc nội dung." };
          
          await updateDbStatus(docId, `AI đang chuẩn hóa Index...`);
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
          
          try {
              const context = ocrResult.text.substring(0, 10000);
              const prompt = `Phân tích dữ liệu sau và trả về JSON: { "title": "Tiêu đề", "summary": "Tóm tắt ngắn", "language": "vi/en", "key_information": ["ý chính 1", "ý chính 2"] }. Dữ liệu: ${context}`;
              
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
          
          await sql`UPDATE documents SET extracted_content = ${JSON.stringify(finalContent)}, status = ${ocrResult.isPartial ? 'indexed_partial' : 'indexed'} WHERE id = ${docId}`;
      });

      await step.run("6-vectorize", async () => {
          if (!ocrResult.text || ocrResult.text.length < 10) return;
          await updateDbStatus(docId, `Đang tạo Search Vector...`);
          
          const genAI = new GoogleGenAI({ apiKey: ingestionApiKey });
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