
// DO fix: use correct import and property based text access for @google/genai
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Helper for robust embedding
async function getSafeEmbedding(ai: GoogleGenAI, text: string) {
    try {
        // Try latest model first
        const res = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        // Fallback to older stable model if 404 Not Found
        if (e.message?.includes("404") || e.status === 404 || e.code === 404) {
            console.warn("[RAG] text-embedding-004 not found, falling back to embedding-001");
            const res = await ai.models.embedContent({
                model: "embedding-001",
                contents: [{ parts: [{ text }] }]
            });
            return res.embeddings?.[0]?.values || [];
        }
        throw e;
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
          // Use safe embedding with fallback
          const vector = await getSafeEmbedding(ai, userQuery);
          
          if (vector.length > 0) {
            const queryResponse = await index.query({
                vector,
                topK: 2,
                includeMetadata: true
            });
            for (const m of queryResponse.matches) {
                const fname = m.metadata?.filename as string;
                if (fname && !seen.has(fname)) {
                text += `[VECTOR SEARCH: ${fname}]\n${m.metadata?.text}\n---\n`;
                }
            }
          }
        } catch (e) { console.error("Pinecone Search Error", e); }
      }
      return text;
    })();

    const systemInstruction = `Bạn là Trợ lý HR thông minh. Nhiệm vụ: Hỗ trợ người dùng dựa trên tài liệu được cung cấp (CONTEXT).

    QUY TẮC XỬ LÝ QUAN TRỌNG:
    1. Ưu tiên hàng đầu: NẾU tìm thấy file trong CONTEXT có tên liên quan đến câu hỏi, NHƯNG nội dung file trong CONTEXT bị rỗng, đang xử lý (Scanning/OCR), hoặc không đủ để trả lời chi tiết:
       - HÃY TRẢ LỜI NGẮN GỌN: "Tôi tìm thấy tài liệu liên quan là [Tên file]. Tuy nhiên, nội dung chi tiết đang được xử lý hoặc chưa thể đọc được. Bạn vui lòng xem trực tiếp file đính kèm bên dưới."
       - TUYỆT ĐỐI KHÔNG tự bịa ra câu trả lời hoặc trả lời chung chung dựa trên kiến thức ngoài để tránh gây nhiễu.
       - BẮT BUỘC thêm dòng này vào cuối câu trả lời để hiển thị nút tải: [[File: tên_file_chính_xác]]

    2. NẾU nội dung trong CONTEXT rõ ràng và trả lời được câu hỏi:
       - Trả lời chi tiết, chính xác dựa trên nội dung đó.
       - Cuối câu trả lời BẮT BUỘC thêm dòng: [[File: tên_file_chính_xác]]

    3. NẾU hoàn toàn không tìm thấy file nào liên quan trong CONTEXT:
       - Mới được phép dùng kiến thức HR tổng quát để hỗ trợ, nhưng phải nói rõ là "Thông tin này dựa trên kiến thức chung, không tìm thấy trong tài liệu nội bộ".

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
