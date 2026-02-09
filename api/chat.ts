
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

async function queryHuggingFace(prompt: string, model: string = "mistralai/Mistral-7B-Instruct-v0.2") {
    const hfKey = process.env.HUGGING_FACE_API_KEY;
    if (!hfKey) throw new Error("Missing HF Key");
    
    const response = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
        headers: { Authorization: `Bearer ${hfKey}`, "Content-Type": "application/json" },
        method: "POST",
        body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 1000, return_full_text: false } }),
    });
    const result = await response.json();
    return result[0]?.generated_text || result.generated_text || "";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { messages } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    const userQuery = lastMessage.content;
    // DO fix: Use recommended initialization without fallback
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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

    const systemInstruction = `Bạn là Trợ lý HR. Dựa trên dữ liệu: ${context || "Không có tài liệu."}. Trả lời bằng tiếng Việt chuyên nghiệp.`;

    // 2. Generation with Triple Failover
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    
    try {
      // Ưu tiên 1: Gemini
      // DO fix: generateContentStream returns a promise that resolves to an AsyncGenerator. Must await it before for-await-of loop.
      const chat = await ai.models.generateContentStream({
        model: 'gemini-3-flash-preview',
        contents: [
            { role: 'user', parts: [{ text: systemInstruction }] },
            ...messages.map((m: any) => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{ text: m.content }]
            }))
        ],
        config: { temperature: 0.2 }
      });
      for await (const chunk of chat) {
        if (chunk.text) res.write(chunk.text);
      }
    } catch (geminiError: any) {
      console.warn("Gemini Failed, switching to GROQ (Llama-3):", geminiError.message);
      
      try {
          // Ưu tiên 2: Groq (Llama-3)
          res.write("\n\n[FAILOVER]: Gemini bận, đang dùng Llama-3...\n\n");
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
      } catch (groqError: any) {
          // Ưu tiên 3: Hugging Face (Mistral)
          console.warn("Groq Failed, switching to Hugging Face:", groqError.message);
          res.write("\n\n[CRITICAL FAILOVER]: Đang sử dụng Hugging Face Engine...\n\n");
          const hfPrompt = `<s>[INST] ${systemInstruction}\n\nUser Question: ${userQuery} [/INST]`;
          const hfText = await queryHuggingFace(hfPrompt);
          res.write(hfText);
      }
    }
    res.end();
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`\n\n[FATAL ERROR]: ${error.message}`); res.end(); }
  }
}
