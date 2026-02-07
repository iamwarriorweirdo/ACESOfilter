import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Helper: Recall Memories
// Tạm thời comment out do lỗi "python3: command not found" trên Vercel Node.js runtime.
// Để chức năng này hoạt động, cần triển khai api/memory_bridge.py như một Vercel function Python riêng
// và gọi HTTP từ đây, hoặc chuyển logic Python sang TypeScript.
async function recallMemory(query: string): Promise<string> {
  console.warn("[Memory] RecallMemory is temporarily disabled due to Python runtime issues on Vercel.");
  return "";
  // try {
  //   console.log("[Memory] Attempting to recall memory for query:", query);
  //   const { stdout } = await execAsync(`python3 api/memory_bridge.py --action recall --query "${query.replace(/"/g, '\"')}"`);
  //   const result = JSON.parse(stdout);
  //   console.log("[Memory] Recall result:", result);
  //   return result.answer || "";
  // } catch (e) {
  //   console.error("[Memory] Recall failed", e);
  //   return "";
  // }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    console.log("[Chat API] Request received.");
    const { messages, config } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    const userQuery = lastMessage.content;
    console.log("[Chat API] User Query:", userQuery);

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      console.error("[Chat API] API_KEY is missing");
      throw new Error("API_KEY is missing");
    }
    console.log("[Chat API] API_KEY loaded.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const databaseUrl = process.env.DATABASE_URL;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeIndexName = process.env.PINECONE_INDEX_NAME;

    // Initialization check
    if (!databaseUrl || !pineconeApiKey || !pineconeIndexName) {
      console.error("[Chat API] Missing database or Pinecone configuration", { databaseUrl: !!databaseUrl, pineconeApiKey: !!pineconeApiKey, pineconeIndexName: !!pineconeIndexName });
      throw new Error("Missing database or Pinecone configuration");
    }
    console.log("[Chat API] Database and Pinecone configs loaded.");

    // Initialize DB and Pinecone
    const sql = neon(databaseUrl.replace('postgresql://', 'postgres://'));
    console.log("[Chat API] Neon DB initialized.");
    const pc = new Pinecone({ apiKey: pineconeApiKey });
    const index = pc.index(pineconeIndexName);
    console.log("[Chat API] Pinecone initialized.");

    // Fetch Context & Memories in Parallel
    const [retrieval, memories] = await Promise.all([
      (async () => {
        let text = "";
        const files = new Set<string>();
        console.log("[Retrieval] Starting database search...");

        // 1. Database Search
        try {
          const docs = await sql`
            SELECT name, extracted_content FROM documents 
            WHERE name ILIKE ${`%${userQuery}%`} OR extracted_content ILIKE ${`%${userQuery}%`}
            LIMIT 3
          `;
          console.log("[Retrieval] Database search results count:", docs.length);
          for (const d of docs) {
            files.add(d.name);
            text += `[FILE: ${d.name}]\n${d.extracted_content?.substring(0, 2000)}\n---\n`;
          }
        } catch (e) { console.error("[Retrieval] DB error during search:", e); }

        // 2. Vector Search (if needed)
        if (text.length < 2000) {
          console.log("[Retrieval] Starting vector search...");
          try {
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" }); 
            // Correct format for embedContent
            const embed = await model.embedContent(userQuery); 
            const queryResponse = await index.query({
              vector: embed.embedding.values,
              topK: 3,
              includeMetadata: true
            });
            console.log("[Retrieval] Pinecone vector search results count:", queryResponse.matches.length);
            for (const m of queryResponse.matches) {
              const fname = m.metadata?.filename as string;
              if (fname && !files.has(fname)) {
                text += `[SEMANTIC FILE: ${fname}]\n${m.metadata?.text}\n---\n`;
              }
            }
          } catch (e) { console.error("[Retrieval] Pinecone error during search:", e); }
        }
        console.log("[Retrieval] Final context text length:", text.length);
        return text;
      })(),
      recallMemory(userQuery)
    ]);

    if (!retrieval.trim()) {
      console.warn("[Chat API] No retrieval context found, sending default message.");
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.write("Tôi không tìm thấy thông tin phù hợp trong tài liệu.");
      res.end();
      return;
    }

    const systemPrompt = `Bạn là Trợ lý HR. Dựa vào CONTEXT và AGENTIC MEMORY dưới đây để trả lời.
    MEMORY: ${memories || "(No relevant memories)"}
    CONTEXT: ${retrieval}`;
    console.log("[Chat API] System Prompt prepared.");

    // Using correct model names for v1beta API
    const modelId = config?.aiModel === 'gemini-pro' ? 'gemini-pro' : 'gemini-flash'; 
    console.log("[Chat API] Using AI Model:", modelId);
    const model = genAI.getGenerativeModel({ model: modelId });

    const chat = model.startChat({
      history: messages.slice(0, -1).map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: 0.2 },
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] }
    });
    console.log("[Chat API] Chat session started.");

    const result = await chat.sendMessageStream(userQuery);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    console.log("[Chat API] Streaming AI response...");
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) res.write(chunkText);
    }
    res.end();
    console.log("[Chat API] Response stream ended.");

  } catch (error: any) {
    console.error("Critical Chat API Error:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    } else {
      res.write(`\n\n[SYSTEM ERROR]: ${error.message}`);
      res.end();
    }
  }
}
