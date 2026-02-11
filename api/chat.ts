import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import Groq from "groq-sdk";
import type { VercelRequest, VercelResponse } from '@vercel/node';

async function getSafeEmbedding(ai: GoogleGenAI, text: string, configEmbeddingModel: string = 'text-embedding-004') {
    const openAiKey = process.env.OPEN_AI_API_KEY;
    
    if (configEmbeddingModel.includes('text-embedding-3') && openAiKey) {
         try {
             const openAiRes = await (fetch as any)("https://api.openai.com/v1/embeddings", {
                 method: "POST",
                 headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openAiKey}` },
                 body: JSON.stringify({ model: configEmbeddingModel, input: text })
             });
             const data = await openAiRes.json();
             const vec = data.data?.[0]?.embedding;
             if (vec && vec.length > 0) return vec;
         } catch (oe) { }
    }

    try {
        const res = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error("Gemini embedding failed:", e.message);
        return [];
    }
}

async function queryOpenAI(messages: any[], model: string, res: VercelResponse) {
    const apiKey = process.env.OPEN_AI_API_KEY;
    if (!apiKey) throw new Error("Missing OPEN_AI_API_KEY");

    const openAiResponse = await (fetch as any)("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({ model: model, messages: messages, stream: true })
    });

    if (!openAiResponse.ok) throw new Error(`OpenAI Error: ${openAiResponse.statusText}`);
    const reader = openAiResponse.body?.getReader();
    const decoder = new TextDecoder();

    while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter(line => line.trim() !== "");
        for (const line of lines) {
            if (line.startsWith("data: ")) {
                const dataStr = line.replace("data: ", "");
                if (dataStr === "[DONE]") continue;
                try {
                    const data = JSON.parse(dataStr);
                    const content = data.choices[0]?.delta?.content || "";
                    if (content) res.write(content);
                } catch (e) { }
            }
        }
    }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const { messages, config } = req.body;
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    let inputModel = config?.aiModel || config?.chatModel || 'gemini-3-flash-preview';
    let selectedModel = 'gemini-3-flash-preview';
    
    if (inputModel.includes('gpt')) selectedModel = inputModel;
    else if (inputModel.includes('llama') || inputModel.includes('qwen')) selectedModel = inputModel;
    else if (inputModel.includes('gemini')) selectedModel = inputModel;
    else selectedModel = 'gemini-3-flash-preview';

    const embeddingModel = config?.embeddingModel || 'text-embedding-004';
    const userQuery = lastMessage.content;
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });
    
    const sql = neon(process.env.DATABASE_URL!.replace('postgresql://', 'postgres://'));
    const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    const index = pc.index(process.env.PINECONE_INDEX_NAME!);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');

    const contextPromise = (async () => {
      let text = "";
      const seen = new Set<string>();
      
      const processContent = (raw: string | null) => {
          if (!raw) return "[[Nội dung trống]]";
          if (raw.includes("Đang chờ xử lý") || raw.includes("pending")) 
              return "[[Nội dung chưa sẵn sàng]]";
          try {
              const trimmed = raw.trim();
              if (trimmed.startsWith('{')) {
                  const data = JSON.parse(trimmed);
                  // JSON Clean Strategy: Only extracting essential text to reduce noise
                  return `Title: ${data.title}\nSummary: ${data.summary}\nFull Text: ${data.full_text_content || ""}`;
              }
          } catch (e) { }
          return raw;
      };

      // 1. IMPROVED RETRIEVAL: Query Expansion & Keyword Tokenization
      // Tách từ khóa để tìm kiếm linh hoạt hơn (giả lập ElasticSearch behavior)
      const keywords = userQuery.split(/\s+/).filter((w: string) => w.length > 2).map((w: string) => `%${w}%`);
      
      // SQL Query: Tìm file có tên chứa TẤT CẢ từ khóa quan trọng (High Precision) hoặc nội dung chứa từ khóa
      // Đây là bước "Sơ loại" (First Pass Retrieval)
      const validDocsPromise = sql`SELECT name, extracted_content FROM documents`; 
      const vectorPromise = getSafeEmbedding(ai, userQuery, embeddingModel);

      const [allDocs, vector] = await Promise.all([validDocsPromise, vectorPromise]);
      const validFileNames = new Set(allDocs.map(d => d.name));

      // 2. HEURISTIC RERANKING (Thay thế cho Rerank Model đắt tiền)
      // Chúng ta chấm điểm từng file dựa trên mức độ khớp với câu hỏi
      const scoredDocs = allDocs.map((d: any) => {
          let score = 0;
          const nameLower = d.name.toLowerCase();
          const queryLower = userQuery.toLowerCase();
          
          // Exact Match Name: Điểm cực cao (User gọi đích danh file)
          if (nameLower.includes(queryLower)) score += 100;
          
          // Keyword Match Name: Điểm trung bình
          keywords.forEach((k: string) => {
              if (nameLower.includes(k.replace(/%/g, '').toLowerCase())) score += 20;
          });

          return { ...d, score };
      }).sort((a: any, b: any) => b.score - a.score); // Sắp xếp giảm dần theo điểm

      // Lấy Top 3 file điểm cao nhất (Keyword Search Results)
      const topKeywordDocs = scoredDocs.filter((d: any) => d.score > 0).slice(0, 3);

      for (const d of topKeywordDocs) {
          seen.add(d.name);
          // Cho phép context lớn (30k chars) vì Gemini Flash xử lý tốt
          text += `[PRIORITY FILE MATCH]: "${d.name}"\n${processContent(d.extracted_content).substring(0, 30000)}\n---\n`;
      }

      // 3. SEMANTIC SEARCH (Vector Search - Pinecone)
      // Tìm kiếm dựa trên ý nghĩa (dành cho câu hỏi mơ hồ, không trúng từ khóa)
      if (text.length < 100000 && vector.length > 0) {
          try {
              const queryResponse = await index.query({ vector, topK: 5, includeMetadata: true });
              for (const m of queryResponse.matches) {
                  const fname = m.metadata?.filename as string;
                  const existsInDb = Array.from(validFileNames).some(name => name.toLowerCase() === fname?.toLowerCase());

                  if (fname && existsInDb && !seen.has(fname)) {
                      const dbMatch = allDocs.find(d => d.name.toLowerCase() === fname.toLowerCase());
                      const content = dbMatch ? processContent(dbMatch.extracted_content) : String(m.metadata?.text || "");
                      
                      text += `[SEMANTIC MATCH]: "${fname}"\n${content.substring(0, 20000)}\n---\n`;
                      seen.add(fname);
                  }
              }
          } catch (pe) { console.error("Pinecone query error", pe); }
      }
      return text;
    })();

    const context = await contextPromise;

    // 4. ADVANCED SYSTEM PROMPT (Chain-of-Thought)
    const systemInstruction = `Bạn là Chuyên gia Phân tích Dữ liệu Doanh nghiệp (AI Senior Analyst).

QUY TRÌNH SUY LUẬN (Bắt buộc thực hiện ngầm):
1. **Phân tích Context**: Đọc kỹ các phần [PRIORITY FILE MATCH] và [SEMANTIC MATCH].
2. **Đối chiếu**: So sánh từ khóa trong câu hỏi của người dùng với nội dung tài liệu.
3. **Trích xuất**: Lấy ra chính xác đoạn văn bản chứa câu trả lời.
4. **Tổng hợp**: Viết câu trả lời dựa trên thông tin đã trích xuất.

LUẬT TRẢ LỜI:
- **KHÔNG BỊA ĐẶT**: Chỉ trả lời dựa trên Context. Nếu không có, nói rõ là không tìm thấy trong tài liệu nào.
- **DẪN CHỨNG CỤ THỂ**: Khi đưa ra thông tin, phải ghi rõ nguồn từ file nào.
- **ĐỊNH DẠNG LINK FILE**: Bắt buộc dùng cú pháp [[File: Tên_File_Chính_Xác]] mỗi khi nhắc đến tài liệu để tạo link tải. Ví dụ: "Theo quy định trong [[File: Noi_quy.pdf]]...".
- **CHẤP NHẬN FILE LIÊN QUAN**: Nếu người dùng hỏi "Nội quy" và có file "HR_ACESO_NỘI QUY.pdf", hãy coi đó là file đúng và trả lời nội dung bên trong.

Context Dữ Liệu:
${context || "Không tìm thấy dữ liệu nào khớp với câu hỏi."}`;

    if (selectedModel.includes('gpt')) {
        await queryOpenAI([{ role: 'system', content: systemInstruction }, ...messages], selectedModel, res);
    } else if (selectedModel.includes('llama') || selectedModel.includes('qwen')) {
        const strRes = await groq.chat.completions.create({
            messages: [{ role: 'system', content: systemInstruction }, ...messages] as any,
            model: selectedModel,
            stream: true,
            temperature: 0.1
        });
        for await (const chunk of strRes) { res.write(chunk.choices[0]?.delta?.content || ""); }
    } else {
        const chatStream = await ai.models.generateContentStream({
            model: selectedModel,
            contents: messages.map((m: any) => ({
                role: m.role === 'assistant' || m.role === 'model' ? 'model' : 'user',
                parts: [{ text: m.content }]
            })),
            config: {
                systemInstruction: systemInstruction,
                temperature: 0.1
            }
        });

        for await (const chunk of chatStream) {
            if (chunk.text) res.write(chunk.text);
        }
    }
    res.end();
  } catch (error: any) {
    console.error("Chat Error Handled:", error);
    if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Internal Server Error" });
    } else {
        res.write(`\n\n[Lỗi hệ thống]: ${error.message}`);
        res.end();
    }
  }
}
