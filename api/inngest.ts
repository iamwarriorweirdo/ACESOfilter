
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

function getEnv(key: string): string | undefined {
    return process.env[key] || 
           process.env[key.toUpperCase()] || 
           process.env[`NEXT_PUBLIC_${key}`] ||
           process.env[`NEXT_PUBLIC_${key.toUpperCase()}`];
}

async function getEmbeddingWithFallback(ai: GoogleGenAI, text: string, primaryModel: string = 'text-embedding-004'): Promise<number[]> {
    try {
        const res = await ai.models.embedContent({
            model: primaryModel,
            contents: { parts: [{ text }] }
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error(`Embedding failed with ${primaryModel}:`, e.message);
        return [];
    }
}

function getMimeType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'heic') return 'image/heic';
  if (ext === 'heif') return 'image/heif';
  if (ext === 'txt') return 'text/plain'; 
  return 'application/octet-stream'; 
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
        await sql`UPDATE documents SET status = ${message.substring(0, 50)} WHERE id = ${docId}`;
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

/**
 * Deep Extraction cho Docx: Quét XML để lấy text trong Text Box, Table, Header, Footer
 */
async function extractDocxDeepText(buffer: Buffer): Promise<string> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files).filter(f => f.endsWith('.xml'));
    let fullText = "";
    
    for (const f of files) {
        const content = await zip.file(f)?.async("string");
        if (!content) continue;
        const matches = content.match(/<w:t[^>]*>(.*?)<\/w:t>/g);
        if (matches) {
            fullText += matches.map(val => val.replace(/<[^>]+>/g, '')).join(' ') + " ";
        }
    }
    return fullText.trim();
  } catch (e) { return ""; }
}

const processFileInBackground = inngest.createFunction(
  { id: "process-file-background", retries: 0 },
  { event: "app/process.file" },
  async ({ event, step }) => {
    const { url, fileName, docId } = event.data;

    try {
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

      // DETERMINE API KEY for Ingestion Workload (OCR + Embedding)
      // Prioritize: process.env.OCR_API_KEY -> config.ocrApiKey -> process.env.API_KEY
      const ingestionApiKey = process.env.OCR_API_KEY || configStep.ocrApiKey || process.env.API_KEY || "";
      
      // Use this specific instance for heavy lifting
      const ingestionAi = new GoogleGenAI({ apiKey: ingestionApiKey });

      const extractionResults = await step.run("extract-analyze-store", async () => {
        await updateDbStatus(docId, `Bắt đầu xử lý file: ${fileName}`);
        
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
            // @ts-ignore - Fix TS7016 by ignoring lack of types in serverless environment
            const mammoth = await import('mammoth');
            const extractor = mammoth.default || (mammoth as any);
            const res = await extractor.extractRawText({ buffer });
            text = res.value;
            method = "docx-mammoth";
            
            if (!text || text.trim().length < 10) {
                text = await extractDocxDeepText(buffer);
                method = "docx-deep-xml";
            }
          } catch (e) {
            text = await extractDocxDeepText(buffer);
            method = "docx-deep-xml-fallback";
          }
        } else if (lowName.endsWith('.pdf')) {
          try {
            // @ts-ignore - Fix TS7016
            const pdfParseModule = await import('pdf-parse');
            const pdfExtractor = pdfParseModule.default || (pdfParseModule as any);
            const data = await pdfExtractor(buffer);
            text = data.text;
            method = "pdf-parse";
          } catch (e) {
            method = "pdf-parse-failed";
          }
        }

        const isAIRequired = !text || text.trim().length < 20 || 
                             preferredOcrModel.includes('vision') || 
                             preferredOcrModel.includes('gpt');

        if (isAIRequired) {
             await updateDbStatus(docId, `AI OCR kích hoạt (${preferredOcrModel})...`);
             if (preferredOcrModel.startsWith('gpt')) {
                 text = await callOpenAIVision(bufferBase64, preferredOcrModel);
                 method = "openai-vision";
             } else if (preferredOcrModel.includes('llama') && preferredOcrModel.includes('vision')) {
                 text = await callGroqVision(bufferBase64, preferredOcrModel);
                 method = "groq-vision";
             } else {
                const mimeType = getMimeType(fileName);
                
                if (mimeType !== 'application/octet-stream') {
                    // Using dedicated ingestion Key
                    const res = await ingestionAi.models.generateContent({
                      model: 'gemini-3-flash-preview', // OCR always uses powerful model
                      contents: {
                          parts: [
                            { inlineData: { data: bufferBase64, mimeType: mimeType } },
                            { text: "Extract ALL text from this document. If it is a form, extract the fields and values. Return raw text only." }
                          ]
                      }
                    });
                    text = res.text || "";
                    method = "gemini-ocr-vision-dedicated";
                }
             }
        }

        if (!text || text.trim().length === 0) {
            throw new Error(`Không thể trích xuất nội dung từ ${fileName}. Phương pháp cuối cùng (${method}) trả về rỗng.`);
        }

        let meta = { title: fileName, summary: "Tài liệu hệ thống", key_information: [], language: "vi" };
        const analysisModel = configStep.analysisModel || 'gemini-3-flash-preview';
        
        try {
           if (analysisModel.startsWith('gpt')) {
                  const opts = {
                    method: "POST",
                    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPEN_AI_API_KEY}` },
                    body: JSON.stringify({
                        model: analysisModel,
                        messages: [{ role: "user", content: `Trả về JSON {title, summary, key_information, language} cho văn bản: ${text.substring(0, 4000)}` }],
                        response_format: { type: "json_object" }
                    })
                  };
                  const res = await (fetch as any)("https://api.openai.com/v1/chat/completions", opts);
                  const data = await res.json();
                  meta = JSON.parse(data.choices[0]?.message?.content || "{}");
             } else {
                 // Analysis also uses ingestion key
                 const res = await ingestionAi.models.generateContent({
                    model: 'gemini-3-flash-preview',
                    contents: { parts: [{ text: `Phân tích văn bản và trả về JSON {title, summary, key_information, language}: ${text.substring(0, 4000)}` }] },
                    config: { responseMimeType: 'application/json' }
                 });
                 meta = JSON.parse(res.text || "{}");
             }
        } catch (e) { }

        const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
        const { neon } = await import('@neondatabase/serverless');
        const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
        
        await sql`UPDATE documents SET extracted_content = ${JSON.stringify({ ...meta, full_text_content: text, parse_method: method, text_length: text.length })}, status = 'indexed' WHERE id = ${docId}`;
        
        return { success: true, method, textLength: text.length, docId };
      });

      await step.run("generate-vectors", async () => {
          const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
          const { neon } = await import('@neondatabase/serverless');
          const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));
          
          const rows = await sql`SELECT extracted_content FROM documents WHERE id = ${docId}`;
          if (rows.length === 0) return;
          
          let contentData = JSON.parse(rows[0].extracted_content);
          const textToEmbed = contentData.full_text_content || "";
          if (!textToEmbed) return;

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
              // Vector generation uses ingestion key (Critical for avoiding Chat API limits)
              vector = await getEmbeddingWithFallback(ingestionAi, textToEmbed.substring(0, 3000), preferredEmbeddingModel);
          }

          if (vector.length > 0 && process.env.PINECONE_API_KEY) {
              const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
              await pc.index(process.env.PINECONE_INDEX_NAME!).upsert([{ id: docId, values: vector, metadata: { filename: fileName, text: textToEmbed.substring(0, 4000) } }] as any);
              await sql`UPDATE documents SET status = 'v3.0.0-indexed' WHERE id = ${docId}`;
          }
      });

      return { 
          status: "completed", 
          docId, 
          method: extractionResults.method, 
          length: extractionResults.textLength 
      };

    } catch (e: any) {
      await updateDbStatus(docId, e.message, true);
      return { status: "failed", error: e.message };
    }
  }
);

const deleteFileInBackground = inngest.createFunction(
    { id: "delete-file-background" },
    { event: "app/delete.file" },
    async ({ event, step }) => {
        const { docId, url } = event.data;

        await step.run("delete-pinecone", async () => {
             if (process.env.PINECONE_API_KEY && process.env.PINECONE_INDEX_NAME) {
                 try {
                     const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
                     await pc.index(process.env.PINECONE_INDEX_NAME).deleteMany([docId]);
                 } catch (e: any) { }
             }
        });

        await step.run("delete-storage", async () => {
            if (!url || typeof url !== 'string') return;

            if (url.includes('cloudinary.com')) {
                const cloudName = getEnv('CLOUDINARY_CLOUD_NAME');
                const apiKey = getEnv('CLOUDINARY_API_KEY');
                const apiSecret = getEnv('CLOUDINARY_API_SECRET');

                if (cloudName && apiKey && apiSecret) {
                    cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
                    const regex = /\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/;
                    const match = url.match(regex);
                    if (match && match[1]) {
                        try {
                            await cloudinary.uploader.destroy(match[1]);
                        } catch (e) { }
                    }
                }
            } 
            else if (url.includes('supabase.co')) {
                const sbUrl = getEnv('SUPABASE_URL');
                const sbKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

                if (sbUrl && sbKey) {
                    try {
                        const supabase = createClient(sbUrl, sbKey);
                        const urlObj = new URL(url);
                        const pathParts = urlObj.pathname.split('/documents/');
                        if (pathParts.length > 1) {
                            const filePath = decodeURIComponent(pathParts[1]);
                            await supabase.storage.from('documents').remove([filePath]);
                        }
                    } catch (e) { }
                }
            }
        });
        
        return { deleted: docId };
    }
);

const syncDatabaseBackground = inngest.createFunction(
    { id: "sync-database-background" },
    { event: "app/sync.database" },
    async ({ event, step }) => {
        const results = await step.run("sync-execution", async () => {
             const apiKey = process.env.PINECONE_API_KEY;
             const indexName = process.env.PINECONE_INDEX_NAME;
             
             if (!apiKey || !indexName) throw new Error("Missing PINECONE_API_KEY or PINECONE_INDEX_NAME");
             
             const pc = new Pinecone({ apiKey });
             
             // Verify Index Exists First to avoid 404 on 'default'
             const indexes = await pc.listIndexes();
             const exists = indexes.indexes?.some(i => i.name === indexName);
             if (!exists) {
                 throw new Error(`Index '${indexName}' does not exist. Available: ${indexes.indexes?.map(i => i.name).join(', ')}`);
             }

             const index = pc.index(indexName);

             // Connect to DB
             const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
             const { neon } = await import('@neondatabase/serverless');
             const sql = neon(dbUrl!.replace('postgresql://', 'postgres://'));

             // 1. Get DB IDs
             const dbDocs = await sql`SELECT id FROM documents`;
             const dbIdSet = new Set(dbDocs.map((d: any) => d.id));

             // 2. Scan Pinecone
             let orphans: string[] = [];
             let pageToken: string | undefined = undefined;
             let count = 0;

             do {
                const listResults = await index.listPaginated({ limit: 100, paginationToken: pageToken });
                if (listResults.vectors) {
                    for (const v of listResults.vectors) {
                        if (v.id && !dbIdSet.has(v.id)) {
                            orphans.push(v.id);
                        }
                    }
                }
                pageToken = listResults.pagination?.next;
                count++;
                if (count > 50) break; // Limit safety loop
             } while (pageToken);

             // 3. Delete Orphans
             if (orphans.length > 0) {
                 // Batch delete 100
                 const toDelete = orphans.slice(0, 100); 
                 await index.deleteMany(toDelete);
                 return { deleted: toDelete.length, totalOrphansDetected: orphans.length };
             }

             return { deleted: 0, status: "Clean" };
        });

        return results;
    }
);

export default serve({ client: inngest, functions: [processFileInBackground, deleteFileInBackground, syncDatabaseBackground] });
