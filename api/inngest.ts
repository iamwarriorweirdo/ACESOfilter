
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

// Advanced HF Inference for Vision Models
async function callHFInference(buffer: Buffer, modelId: string) {
    const hfKey = process.env.HUGGING_FACE_API_KEY;
    if (!hfKey) throw new Error("Missing HUGGING_FACE_API_KEY");
    
    // Determine payload type based on model
    const isPhi3 = modelId.toLowerCase().includes('phi-3') || modelId.toLowerCase().includes('vision');
    
    let body: any;
    let contentType = "application/octet-stream";

    if (isPhi3) {
        // Phi-3-vision and other Instruct VLMs typically require a JSON payload with instructions
        const base64Image = buffer.toString('base64');
        const dataUri = `data:image/jpeg;base64,${base64Image}`;
        
        // Standard payload for HF Inference API for VLM (User/Assistant structure)
        body = JSON.stringify({
            inputs: {
                image: base64Image, // Some endpoints take base64 directly
                prompt: `<|user|>\n<|image_1|>\nOCR Task: Extract ALL text from this image verbatim. Do not summarize. Just return the text content.\n<|end|>\n<|assistant|>\n`
            },
            parameters: { max_new_tokens: 2000 }
        });
        contentType = "application/json";
    } else {
        // Florence-2 and generic image-to-text often accept raw bytes
        body = buffer;
    }

    const response = await fetch(`https://api-inference.huggingface.co/models/${modelId}`, {
        headers: { Authorization: `Bearer ${hfKey}`, "Content-Type": contentType },
        method: "POST",
        body: body,
    });
    
    const result = await response.json();
    
    // Error handling
    if (result.error) {
         throw new Error(`HF Error: ${result.error}`);
    }

    // Parsing strategies
    if (Array.isArray(result) && result[0]?.generated_text) return result[0].generated_text;
    if (result.generated_text) return result.generated_text;
    
    return typeof result === 'string' ? result : JSON.stringify(result);
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
      // 1. Fetch Config to check for Preferred OCR Model
      const configStep = await step.run("get-config", async () => {
         const dbUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
         if (!dbUrl) return {};
         const { neon } = await import('@neondatabase/serverless');
         const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
         const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
         return rows.length > 0 ? JSON.parse(rows[0].data) : {};
      });
      
      const preferredOcrModel = configStep.ocrModel || 'gemini-3-flash-preview';

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
        return { text, method, bufferBase64: buffer.toString('base64'), buffer };
      });

      const finalResult = await step.run("ocr-and-failover", async () => {
        let text = parseResult.text;
        let method = parseResult.method;

        // Condition to trigger AI OCR:
        // 1. Text too short/garbage
        // 2. Explicitly selected HF or Phi-3
        // 3. Explicitly selected Gemini Vision
        const isAIRequired = !text || text.trim().length < 20 || 
                             preferredOcrModel.includes('huggingface') || 
                             preferredOcrModel.includes('florence') ||
                             preferredOcrModel.includes('phi-3') ||
                             preferredOcrModel.includes('vision');

        if (isAIRequired) {
          try {
             if (preferredOcrModel.includes('huggingface') || preferredOcrModel.includes('florence') || preferredOcrModel.includes('phi-3')) {
                 const modelId = preferredOcrModel.includes('/') ? preferredOcrModel : "microsoft/Florence-2-base";
                 await updateDbStatus(docId, `Chuyển sang HF Inference: ${modelId}...`);
                 
                 const buf = Buffer.isBuffer(parseResult.buffer) ? parseResult.buffer : Buffer.from(parseResult.buffer as any);
                 text = await callHFInference(buf, modelId);
                 method = modelId.split('/')[1] || "hf-model";
             } else {
                await updateDbStatus(docId, "Sử dụng Gemini 3.0 Vision OCR...");
                const res = await ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: [{ role: 'user', parts: [
                    { inlineData: { data: parseResult.bufferBase64, mimeType: 'application/octet-stream' } },
                    { text: "OCR Task: Extract all text from this image/document accurately." }
                  ]}]
                });
                text = res.text || "";
                method = "gemini-ocr-vision";
             }
          } catch (e: any) {
            await updateDbStatus(docId, `OCR Error (${method}): ${e.message}. Retrying with Gemini Fallback...`);
            // Fallback to Gemini if HF fails
             try {
                const res = await ai.models.generateContent({
                  model: 'gemini-3-flash-preview',
                  contents: [{ role: 'user', parts: [
                    { inlineData: { data: parseResult.bufferBase64, mimeType: 'application/octet-stream' } },
                    { text: "Recover text content from this file." }
                  ]}]
                });
                text = res.text || text; // Use Gemini text if successful
                if (res.text) method = "gemini-fallback";
             } catch (geminiErr) {
                 if (!text) throw new Error("All OCR methods failed.");
             }
          }
        }
        return { text, method };
      });

      await step.run("indexing", async () => {
          let meta = { title: fileName, summary: "Tài liệu", key_information: [], language: "vi" };
          try {
             // Sử dụng model được cấu hình để phân tích JSON
             const analysisModel = configStep.analysisModel || 'gemini-3-flash-preview';
             const res = await ai.models.generateContent({
                model: analysisModel,
                contents: [{ role: 'user', parts: [{ text: `Trả về JSON {title, summary, key_information, language} cho: ${finalResult.text.substring(0, 3000)}` }] }],
                config: { responseMimeType: 'application/json' }
             });
             meta = JSON.parse(res.text || "{}");
          } catch (e) {
             try {
                // Failover sang Groq
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
