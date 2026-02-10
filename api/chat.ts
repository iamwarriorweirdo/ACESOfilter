
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
        if (openAiKey) {
             try {
                 const openAiRes = await (fetch as any)("https://api.openai.com/v1/embeddings", {
                     method: "POST",
                     headers: { "Content-Type": "application/json", "Authorization": `Bearer ${openAiKey}` },
                     body: JSON.stringify({ model: "text-embedding-3-small", input: text })
                 });
                 const data = await openAiRes.json();
                 return data.data?.[0]?.embedding || [];
             } catch (oe) { }
        }
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

    // Lọc model name: Tuyệt đối không để giá trị "auto" lọt vào SDK
    let inputModel = config?.aiModel || config?.chatModel || 'gemini-3-flash-preview';
    let selectedModel = 'gemini-3-flash-preview';
    
    if (inputModel.includes('gpt')) selectedModel = inputModel;
    else if (inputModel.includes('llama') || inputModel.includes('qwen')) selectedModel = inputModel;
    else if (inputModel.includes('gemini')) selectedModel = inputModel;
    // Fallback nếu model là "auto" hoặc bất kỳ chuỗi lạ nào
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
          if (!raw || raw.length < 50 || raw.includes("Đang chờ xử lý") || raw.includes("pending")) 
              return "[[Nội dung chưa sẵn sàng]]";
          return raw;
      };

      const [dbDocs, vector] = await Promise.all([
          sql`SELECT name, extracted_content FROM documents WHERE name ILIKE ${`%${userQuery}%`} OR extracted_content ILIKE ${`%${userQuery}%`} LIMIT 3`.catch(() => []),
          getSafeEmbedding(ai, userQuery, embeddingModel)
      ]);

      for (const d of dbDocs) {
          seen.add(d.name);
          text += `File: "${d.name}"\nContent: ${processContent(d.extracted_content).substring(0, 3000)}\n---\n`;
      }

      if (text.length < 4000 && vector.length > 0) {
          try {
              const queryResponse = await index.query({ vector, topK: 3, includeMetadata: true });
              for (const m of queryResponse.matches) {
                  const fname = m.metadata?.filename as string;
                  if (fname && !seen.has(fname)) {
                      text += `File: "${fname}"\nContent: ${String(m.metadata?.text || "").substring(0, 2000)}\n---\n`;
                  }
              }
          } catch (pe) { console.error("Pinecone query error", pe); }
      }
      return text;
    })();

    const context = await contextPromise;

    const systemInstruction = `Bạn là Trợ lý AI chuyên trách tài liệu nội bộ.
QUY TẮC:
1. CHỈ sử dụng thông tin từ phần "Context" bên dưới.
2. Nếu không có trong Context, hãy trả lời: "Tôi không tìm thấy thông tin này trong tài liệu hệ thống."
3. Cung cấp link file bằng cú pháp [[File: Tên_File]] nếu nhắc tới file đó.

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
        // Gemini Models
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
        res.write(`\n\n[Lỗi kết nối AI]: ${error.message}`);
        res.end();
    }
  }
}
