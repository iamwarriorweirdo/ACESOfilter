
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import Groq from "groq-sdk";
import type { VercelRequest, VercelResponse } from '@vercel/node';

async function getSafeEmbedding(ai: GoogleGenAI, text: string) {
    try {
        const res = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error("[Chat RAG] Embedding Error:", e.message);
        return [];
    }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { messages } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    const userQuery = lastMessage.content;
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || "" });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });
    const databaseUrl = process.env.DATABASE_URL;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeIndexName = process.env.PINECONE_INDEX_NAME;

    if (!databaseUrl || !pineconeApiKey || !pineconeIndexName) throw new Error("Missing configuration for RAG");

    const sql = neon(databaseUrl.replace('postgresql://', 'postgres://'));
    const pc = new Pinecone({ apiKey: pineconeApiKey });
    const index = pc.index(pineconeIndexName);

    // 1. Retrieval (DB + Vector)
    const context = await (async () => {
      let text = "";
      const seen = new Set<string>();
      try {
        const docs = await sql`
          SELECT name, extracted_content FROM documents 
          WHERE name ILIKE ${`%${userQuery}%`} OR extracted_content ILIKE ${`%${userQuery}%`}
          LIMIT 2
        `;
        for (const d of docs) {
          seen.add(d.name);
          text += `[FILE: ${d.name}]\n${d.extracted_content?.substring(0, 1500)}\n---\n`;
        }
      } catch (e) { }

      if (text.length < 1000) {
        const vector = await getSafeEmbedding(ai, userQuery);
        if (vector.length > 0) {
          const queryResponse = await index.query({ vector, topK: 2, includeMetadata: true });
          for (const m of queryResponse.matches) {
              const fname = m.metadata?.filename as string;
              if (fname && !seen.has(fname)) {
                text += `[VECTOR SEARCH: ${fname}]\n${m.metadata?.text}\n---\n`;
              }
          }
        }
      }
      return text;
    })();

    const systemInstruction = `Bạn là Trợ lý HR. Dựa trên dữ liệu: ${context || "Không có tài liệu."}. Trả lời chuyên nghiệp.`;

    // 2. Generation with Failover
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    
    try {
      // Thử dùng Gemini trước
      const chat = ai.chats.create({
        model: 'gemini-3-flash-preview',
        config: { systemInstruction, temperature: 0.2 },
        history: messages.slice(0, -1).map((m: any) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }]
        })),
      });
      const result = await chat.sendMessageStream({ message: userQuery });
      for await (const chunk of result) {
        if (chunk.text) res.write(chunk.text);
      }
    } catch (geminiError: any) {
      console.warn("Gemini Failed, switching to GROQ (Llama-3):", geminiError.message);
      res.write("\n\n[INFO]: Gemini Overloaded. Switching to Llama-3 (Groq)...\n\n");
      
      const groqResponse = await groq.chat.completions.create({
        messages: [
          { role: "system", content: systemInstruction },
          ...messages.map((m: any) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))
        ],
        model: "llama-3.1-70b-versatile",
        stream: true,
      });

      for await (const chunk of groqResponse) {
        const content = chunk.choices[0]?.delta?.content || "";
        res.write(content);
      }
    }
    res.end();
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`\n\n[FATAL ERROR]: ${error.message}`); res.end(); }
  }
}
