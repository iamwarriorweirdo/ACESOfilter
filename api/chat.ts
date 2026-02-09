// DO fix: use correct import and property based text access for @google/genai
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { messages, config } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    const userQuery = lastMessage.content;
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API_KEY is missing");

    // DO fix: use GoogleGenAI with named apiKey parameter
    const ai = new GoogleGenAI({ apiKey });
    const databaseUrl = process.env.DATABASE_URL;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeIndexName = process.env.PINECONE_INDEX_NAME;

    if (!databaseUrl || !pineconeApiKey || !pineconeIndexName) {
      throw new Error("Missing configuration for RAG (Database or Pinecone)");
    }

    const sql = neon(databaseUrl.replace('postgresql://', 'postgres://'));
    const pc = new Pinecone({ apiKey: pineconeApiKey });
    const index = pc.index(pineconeIndexName);

    // Truy xuất ngữ cảnh (Stateless RAG)
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
      } catch (e) { console.error("Neon Search Error", e); }

      if (text.length < 1000) {
        try {
          // DO fix: use ai.models.embedContent
          const embedRes = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text: userQuery }] }]
          }); 
          const queryResponse = await index.query({
            vector: embedRes.embeddings?.[0]?.values || embedRes.embedding?.values || [],
            topK: 2,
            includeMetadata: true
          });
          for (const m of queryResponse.matches) {
            const fname = m.metadata?.filename as string;
            if (fname && !seen.has(fname)) {
              text += `[VECTOR SEARCH: ${fname}]\n${m.metadata?.text}\n---\n`;
            }
          }
        } catch (e) { console.error("Pinecone Search Error", e); }
      }
      return text;
    })();

    const systemInstruction = `Bạn là Trợ lý HR thông minh. Trả lời dựa trên CONTEXT được cung cấp.
    Nếu không có thông tin trong CONTEXT, hãy trả lời theo kiến thức chuyên môn HR nhưng nêu rõ là không tìm thấy trong tài liệu nội bộ.
    
    CONTEXT:
    ${context || "Không có tài liệu liên quan được tìm thấy."}`;

    const modelId = config?.aiModel === 'gemini-pro' ? 'gemini-3-pro-preview' : 'gemini-3-flash-preview'; 
    
    // DO fix: use ai.chats.create instead of startChat
    const chat = ai.chats.create({
      model: modelId,
      config: {
        systemInstruction: systemInstruction,
        temperature: 0.2
      },
      history: messages.slice(0, -1).map((m: any) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      })),
    });

    // DO fix: sendMessageStream uses message parameter
    const result = await chat.sendMessageStream({ message: userQuery });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    
    for await (const chunk of result) {
      // DO fix: access text as a property, not a function
      const chunkText = chunk.text;
      if (chunkText) res.write(chunkText);
    }

    res.end();
  } catch (error: any) {
    console.error("Chat API Critical Error:", error);
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`\n\n[LỖI HỆ THỐNG]: ${error.message}`); res.end(); }
  }
}