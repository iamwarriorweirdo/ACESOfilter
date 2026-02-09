
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Helper: Recall Memories via HTTP to Python Function
async function recallMemory(query: string, baseUrl: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/api/memory?action=recall&query=${encodeURIComponent(query)}`);
    if (!response.ok) return "";
    const result = await response.json();
    return result.answer || "";
  } catch (e) {
    console.warn("[Memory] Recall failed via API", e);
    return "";
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { messages, config } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    const userQuery = lastMessage.content;
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API_KEY is missing");

    const genAI = new GoogleGenerativeAI(apiKey);
    const databaseUrl = process.env.DATABASE_URL;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeIndexName = process.env.PINECONE_INDEX_NAME;

    if (!databaseUrl || !pineconeApiKey || !pineconeIndexName) {
      throw new Error("Missing database or Pinecone configuration");
    }

    const sql = neon(databaseUrl.replace('postgresql://', 'postgres://'));
    const pc = new Pinecone({ apiKey: pineconeApiKey });
    const index = pc.index(pineconeIndexName);

    // Dynamic Base URL for Internal Calls
    const protocol = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['host'];
    const baseUrl = `${protocol}://${host}`;

    const [retrieval, memories] = await Promise.all([
      (async () => {
        let text = "";
        const files = new Set<string>();
        try {
          const docs = await sql`
            SELECT name, extracted_content FROM documents 
            WHERE name ILIKE ${`%${userQuery}%`} OR extracted_content ILIKE ${`%${userQuery}%`}
            LIMIT 3
          `;
          for (const d of docs) {
            files.add(d.name);
            text += `[FILE: ${d.name}]\n${d.extracted_content?.substring(0, 2000)}\n---\n`;
          }
        } catch (e) { console.error("[Retrieval] DB error", e); }

        if (text.length < 2000) {
          try {
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" }); 
            const embed = await model.embedContent(userQuery); 
            const queryResponse = await index.query({
              vector: embed.embedding.values,
              topK: 3,
              includeMetadata: true
            });
            for (const m of queryResponse.matches) {
              const fname = m.metadata?.filename as string;
              if (fname && !files.has(fname)) {
                text += `[SEMANTIC FILE: ${fname}]\n${m.metadata?.text}\n---\n`;
              }
            }
          } catch (e) { console.error("[Retrieval] Pinecone error", e); }
        }
        return text;
      })(),
      recallMemory(userQuery, baseUrl)
    ]);

    const systemPrompt = `Bạn là Trợ lý HR ACESOfilter. Dựa vào CONTEXT và MEMORY dưới đây để trả lời.
    MEMORY (Những gì bạn nhớ về các cuộc hội thoại trước): ${memories || "(Không có ký ức liên quan)"}
    CONTEXT (Dữ liệu từ tài liệu nội bộ): ${retrieval || "Không tìm thấy tài liệu phù hợp."}`;

    const modelId = config?.aiModel === 'gemini-pro' ? 'gemini-3-pro-preview' : 'gemini-3-flash-preview'; 
    const model = genAI.getGenerativeModel({ model: modelId });

    const chat = model.startChat({
      history: messages.slice(0, -1).map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
      generationConfig: { temperature: 0.2 },
      systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] }
    });

    const result = await chat.sendMessageStream(userQuery);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    
    let fullResponse = "";
    for await (const chunk of result.stream) {
      const chunkText = chunk.text();
      if (chunkText) {
          fullResponse += chunkText;
          res.write(chunkText);
      }
    }

    // Async Remember (Save memory without blocking)
    fetch(`${baseUrl}/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remember', text: `User: ${userQuery}\nAssistant: ${fullResponse}` })
    }).catch(() => {});

    res.end();
  } catch (error: any) {
    console.error("Critical Chat API Error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`\n\n[SYSTEM ERROR]: ${error.message}`); res.end(); }
  }
}
