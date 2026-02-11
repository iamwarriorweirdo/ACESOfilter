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
          
          // Logic mới: Giải mã JSON nếu có
          try {
              const trimmed = raw.trim();
              if (trimmed.startsWith('{')) {
                  const data = JSON.parse(trimmed);
                  // Ưu tiên lấy full text, sau đó đến summary, cuối cùng là chính nó
                  return data.full_text_content || data.summary || raw;
              }
          } catch (e) {
              // Không phải JSON, trả về text thô
          }
          return raw;
      };

      const validDocsPromise = sql`SELECT name, extracted_content FROM documents`; 
      const vectorPromise = getSafeEmbedding(ai, userQuery, embeddingModel);

      const [allDocs, vector] = await Promise.all([validDocsPromise, vectorPromise]);
      const validFileNames = new Set(allDocs.map(d => d.name));

      // 1. Keyword Search
      const keywordMatches = allDocs.filter((d: any) => {
          const content = d.extracted_content || "";
          return d.name.toLowerCase().includes(userQuery.toLowerCase()) || 
                 content.toLowerCase().includes(userQuery.toLowerCase());
      }).slice(0, 3);

      for (const d of keywordMatches) {
          seen.add(d.name);
          text += `File: "${d.name}"\nContent: ${processContent(d.extracted_content).substring(0, 4000)}\n---\n`;
      }

      // 2. Semantic Search (Pinecone)
      if (text.length < 5000 && vector.length > 0) {
          try {
              const queryResponse = await index.query({ vector, topK: 5, includeMetadata: true });
              for (const m of queryResponse.matches) {
                  const fname = m.metadata?.filename as string;
                  // Chuẩn hóa tên file để so sánh (tránh lỗi lệch ký tự hoặc hoa thường)
                  const existsInDb = Array.from(validFileNames).some(name => name.toLowerCase() === fname?.toLowerCase());

                  if (fname && existsInDb && !seen.has(fname)) {
                      // Tìm nội dung từ DB thay vì dùng metadata của Pinecone (vì metadata Pinecone bị giới hạn độ dài)
                      const dbMatch = allDocs.find(d => d.name.toLowerCase() === fname.toLowerCase());
                      const content = dbMatch ? processContent(dbMatch.extracted_content) : String(m.metadata?.text || "");
                      
                      text += `File: "${fname}"\nContent: ${content.substring(0, 3000)}\n---\n`;
                      seen.add(fname);
                  }
              }
          } catch (pe) { console.error("Pinecone query error", pe); }
      }
      return text;
    })();

    const context = await contextPromise;

    const systemInstruction = `Bạn là Trợ lý AI chuyên trách tài liệu nội bộ của công ty.
QUY TẮC PHẢN HỒI:
1. CHỈ sử dụng thông tin từ phần "Context" bên dưới để trả lời.
2. Nếu không có thông tin trong Context, hãy trả lời: "Tôi không tìm thấy thông tin này trong tài liệu hệ thống. Hiện tại hệ thống có ghi nhận tập tin nhưng nội dung bên trong chưa sẵn sàng để truy xuất."
3. Nếu thông tin có trong Context, hãy trả lời chi tiết và chuyên nghiệp.
4. Luôn dẫn nguồn file bằng cú pháp [[File: Tên_File]] khi trích dẫn.

Context:
${context || "Không tìm thấy dữ liệu liên quan."}`;

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
