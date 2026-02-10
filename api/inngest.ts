import { serve } from "inngest/node";
import { Inngest } from "inngest";
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import Groq from "groq-sdk";
import { Buffer } from 'node:buffer';
import JSZip from 'jszip';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';

export const inngest = new Inngest({ id: "hr-rag-app" });

// Helper: Determine MIME type for AI Vision
function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'heif') return 'image/heif';
  return 'application/octet-stream'; // Fallback
}

async function fetchFileBuffer(url: string) {
  const headers = { 'User-Agent': 'Mozilla/5.0' };
  let targetUrl = url.replace('http://', 'https://').trim();
  const res = await (fetch as any)(targetUrl, { headers });
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

async function callOpenAIVision(bufferBase64: string, model: string = 'gpt-4o-mini') {
    const apiKey = process.env.OPEN_AI_API_KEY;
    if (!apiKey) throw new Error("Missing OPEN_AI_API_KEY");

    const options = {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
            model: model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "OCR Task: Extract ALL text from this image verbatim. Return ONLY the text." },
                        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bufferBase64}` } }
                    ]
                }
            ],
            max_tokens: 2000
        })
    };

    const res = await (fetch as any)("https://api.openai.com/v1/chat/completions", options);
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0]?.message?.content || "";
}

async function callGroqVision(bufferBase64: string, model: string = 'llama-3.2-11b-vision-preview') {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("Missing GROQ_API_KEY");
    const groq = new Groq({ apiKey });

    const chatCompletion = await groq.chat.completions.create({
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Extract text from this image." },
                    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${bufferBase64}` } },
                ] as any,
            },
        ],
        model: model,
    });
    return chatCompletion.choices[0]?.message?.content || "";
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
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });

    try {
      // 1. Get Config (Fast)
      const configStep = await step.run("get-config", async () => {
         const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
         if (!dbUrl) return {};
         const { neon } = await import('@neondatabase/serverless');
         const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
         const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
         return rows.length > 0 ? JSON.parse(rows[0].data) : {};
      });
      
      const preferredOcrModel = configStep.ocrModel || 'gemini-3-flash-preview';
      const preferredEmbeddingModel = configStep.embeddingModel || 'text-embedding-004';

      // 2. Heavy Lifting (Extract + OCR + Analyze + Save DB)
      // CHIẾN THUẬT STORAGE POINTER: Bước này KHÔNG return nội dung file.
      // Nó tải file về, xử lý xong và lưu thẳng vào DB. Chỉ trả về { success: true }.
      await step.run("extract-analyze-store", async () => {
        await updateDbStatus(docId, `Bắt đầu xử lý: ${fileName}`);
        
        // A. Download & Basic Extraction
        const ab = await fetchFileBuffer(url);
        const buffer = Buffer.from(ab);
        const bufferBase64 = buffer.toString('base64');
        const lowName = fileName.toLowerCase();
        let text = "";
        let method = "unknown";

        if (lowName.endsWith('.txt')) {
          text = buffer.toString('utf-8');
          method = "text-plain";
        } else if (lowName.endsWith('.docx')) {
          try {
            const mammoth = await import('mammoth');
            const extractor = mammoth.default || (mammoth as any);
            const res = await extractor.extractRawText({ buffer });
            text = res.value;
            method = "docx-mammoth";
          } catch (e) {
            text = await extractDocxRawTextFallback(buffer);
            method = "docx-jszip";
          }
        } else if (lowName.endsWith('.pdf')) {
          // @ts-ignore
          const pdfParseModule = await import('pdf-parse');
          const pdfExtractor = pdfParseModule.default || (pdfParseModule as any);
          const data = await pdfExtractor(buffer);
          text = data.text;
          method = "pdf-parse";
        }

        // B. Intelligent OCR Fallback
        const isAIRequired = !text || text.trim().length < 20 || 
                             preferredOcrModel.includes('vision') || 
                             preferredOcrModel.includes('gpt') ||
                             preferredOcrModel.includes('vl') ||
                             preferredOcrModel.includes('qwen');

        if (isAIRequired) {
             if (preferredOcrModel.startsWith('gpt')) {
                 await updateDbStatus(docId, `Sử dụng OpenAI Vision (${preferredOcrModel})...`);
                 text = await callOpenAIVision(bufferBase64, preferredOcrModel);
                 method = "openai-vision";
             } else if (preferredOcrModel.includes('llama') && preferredOcrModel.includes('vision')) {
                 await updateDbStatus(docId, `Sử dụng Groq Vision (${preferredOcrModel})...`);
                 text = await callGroqVision(bufferBase64, preferredOcrModel);
                 method = "groq-vision";
             } else {
                await updateDbStatus(docId, "Sử dụng Gemini Vision OCR...");
                const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
                const mimeType = getMimeType(fileName);
                const res = await ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: {
                      parts: [
                        { inlineData: { data: bufferBase64, mimeType: mimeType } },
                        { text: "OCR Task: Extract all text from this image/document accurately." }
                      ]
                  }
                });
                text = res.text || "";
                method = "gemini-ocr-vision";
             }
        }

        // C. Metadata Analysis
        let meta = { title: fileName, summary: "Tài liệu", key_information: [], language: "vi" };
        const analysisModel = configStep.analysisModel || 'gemini-3-flash-preview';
        
        try {
           if (analysisModel.startsWith('gpt')) {
                  const opts = {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPEN_AI_API_KEY}` },
                    body: JSON.stringify({
                        model: analysisModel,
                        messages: [{ role: "user", content: `Trả về JSON {title, summary, key_information, language} cho: ${text.substring(0, 3000)}` }],
                        response_format: { type: "json_object" }
                    })
                  };
                  const res = await (fetch as any)("https://api.openai.com/v1/chat/completions", opts);
                  const data = await res.json();
                  meta = JSON.parse(data.choices[0]?.message?.content || "{}");
             } else if (analysisModel.includes('llama')) {
                const groqRes = await groq.chat.completions.create({
                    messages: [{ role: "user", content: `JSON metadata cho văn bản: ${text.substring(0, 3000)}` }],
                    model: analysisModel,
                    response_format: { type: "json_object" }
                });
                meta = JSON.parse(groqRes.choices[0]?.message?.content || "{}");
             } else {
                 const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
                 const res = await ai.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    contents: { parts: [{ text: `Trả về JSON {title, summary, key_information, language} cho: ${text.substring(0, 3000)}` }] },
                    config: { responseMimeType: 'application/json' }
                 });
                 meta = JSON.parse(res.text || "{}");
             }
        } catch (e) { }

        // D. Save to DB directly
        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
        
        await sql`UPDATE documents SET extracted_content = ${JSON.stringify({ ...meta, full_text_content: text, parse_method: method })}, status = 'processing_embeddings' WHERE id = ${docId}`;
        
        return { success: true, docId };
      });

      // 3. Generate Vectors (Pointer Strategy)
      // Bước này KHÔNG nhận text từ output của bước trước. Nó tự SELECT từ DB bằng docId.
      await step.run("generate-vectors", async () => {
          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          // FETCH CONTENT FROM DB using POINTER (docId)
          const rows = await sql`SELECT extracted_content FROM documents WHERE id = ${docId}`;
          if (rows.length === 0) throw new Error("Document not found in DB");
          
          let contentData;
          try {
              contentData = JSON.parse(rows[0].extracted_content);
          } catch (e) {
              // If simple text or invalid JSON
              contentData = { full_text_content: rows[0].extracted_content };
          }
          
          const textToEmbed = contentData.full_text_content || "";
          if (!textToEmbed) {
               await updateDbStatus(docId, "Không tìm thấy nội dung văn bản để tạo vector.", true);
               return;
          }

          let vector: number[] = [];
          if (preferredEmbeddingModel.includes('text-embedding-3') && process.env.OPEN_AI_API_KEY) {
               const opts = {
                   method: "POST",
                   headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPEN_AI_API_KEY}` },
                   body: JSON.stringify({ model: preferredEmbeddingModel, input: textToEmbed.substring(0, 3000) })
               };
               const res = await (fetch as any)("https://api.openai.com/v1/embeddings", opts);
               const data = await res.json();
               vector = data.data?.[0]?.embedding || [];
          } else {
              const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
              const emb = await ai.models.embedContent({
                  model: "text-embedding-004",
                  contents: { parts: [{ text: textToEmbed.substring(0, 3000) }] }
              });
              vector = emb.embeddings?.[0]?.values || [];
          }

          if (vector.length > 0 && process.env.PINECONE_API_KEY) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              await pc.index(process.env.PINECONE_INDEX_NAME!).upsert([{ id: docId, values: vector, metadata: { filename: fileName, text: textToEmbed.substring(0, 4000) } }] as any);
          }
          
          // Final status update
          await sql`UPDATE documents SET status = 'completed' WHERE id = ${docId}`;
      });

    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
    }
  }
);

// CLEANUP FUNCTION: Delete Cloudinary/Supabase files and Pinecone vectors
const deleteFileInBackground = inngest.createFunction(
    { id: "delete-file-background" },
    { event: "app/delete.file" },
    async ({ event, step }) => {
        const { docId, url } = event.data;

        // 1. Delete from Pinecone
        await step.run("delete-pinecone", async () => {
             if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
                 try {
                     const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                     await pc.index(process.env.PINECONE_INDEX_NAME).deleteMany([docId]);
                 } catch (e) { console.error("Pinecone delete error", e); }
             }
        });

        // 2. Delete from Storage Providers
        await step.run("delete-storage", async () => {
            if (!url || typeof url !== 'string') return;

            // Handle Cloudinary
            if (url.includes('cloudinary.com')) {
                // Must configure explicitly in this scope as it might not be global
                cloudinary.config({
                    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
                    api_key: process.env.CLOUDINARY_API_KEY,
                    api_secret: process.env.CLOUDINARY_API_SECRET
                });

                // Extract public_id: https://res.cloudinary.com/.../upload/v1234/folder/file.ext
                // Matches "folder/file" (no extension) after /upload/(v..)?/
                const regex = /\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/;
                const match = url.match(regex);
                if (match && match[1]) {
                    const publicId = match[1];
                    try {
                        await cloudinary.uploader.destroy(publicId);
                    } catch (e) { console.error("Cloudinary delete error", e); }
                }
            } 
            // Handle Supabase
            else if (url.includes('supabase.co')) {
                try {
                    const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
                    const urlObj = new URL(url);
                    // Standard URL: .../storage/v1/object/public/documents/folder/file.pdf
                    // We need "folder/file.pdf"
                    const pathParts = urlObj.pathname.split('/documents/');
                    if (pathParts.length > 1) {
                        const filePath = decodeURIComponent(pathParts[1]);
                        await supabase.storage.from('documents').remove([filePath]);
                    }
                } catch (e) { console.error("Supabase delete error", e); }
            }
        });
    }
);

export default serve({ client: inngest, functions: [processFileInBackground, deleteFileInBackground] });