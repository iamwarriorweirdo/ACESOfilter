import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import Groq from "groq-sdk";
import type { VercelRequest, VercelResponse } from '@vercel/node';

async function getSafeEmbedding(ai: GoogleGenAI, text: string, configEmbeddingModel: string = 'text-embedding-004') {
    const openAiKey = process.env.OPEN_AI_API_KEY;
    
    // 1. OpenAI (If configured)
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

    // 2. Gemini Primary (text-embedding-004)
    try {
        const res = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.warn(`Gemini text-embedding-004 failed: ${e.message}. Trying fallback...`);
        // 3. Gemini Fallback (embedding-001) - Fixes "model not found" 404 errors
        try {
            const res = await ai.models.embedContent({
                model: "embedding-001",
                contents: [{ parts: [{ text }] }]
            });
            return res.embeddings?.[0]?.values || [];
        } catch (e2) {
             console.error("All embedding attempts failed.");
             return [];
        }
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
      const keywords = userQuery.split(/\s+/).filter((w: string) => w.length > 2).map((w: string) => `%${w}%`);
      
      const validDocsPromise = sql`SELECT name, extracted_content FROM documents`; 
      const vectorPromise = getSafeEmbedding(ai, userQuery, embeddingModel);

      const [allDocs, vector] = await Promise.all([validDocsPromise, vectorPromise]);
      const validFileNames = new Set(allDocs.map(d => d.name));

      // 2. ADVANCED HEURISTIC RERANKING (Name + Content + Relevance)
      const scoredDocs = allDocs.map((d: any) => {
          let score = 0;
          const nameLower = d.name.toLowerCase();
          const queryLower = userQuery.toLowerCase();
          
          let contentLower = "";
          try {
             // Try to parse JSON to search in relevant fields
             if (d.extracted_content?.trim().startsWith('{')) {
                const json = JSON.parse(d.extracted_content);
                contentLower = (json.full_text_content || json.summary || "").toLowerCase();
             } else {
                contentLower = (d.extracted_content || "").toLowerCase();
             }
          } catch {
             contentLower = (d.extracted_content || "").toLowerCase();
          }
          
          // A. Exact Name Match (Highest Priority) - e.g. "Nội quy" found in "Noi_quy.pdf"
          if (nameLower.includes(queryLower)) score += 200;
          
          // B. Exact Content Match (High Priority)
          if (contentLower.includes(queryLower)) score += 50;

          // C. Keyword Matching
          let matchedKeywords = 0;
          keywords.forEach((k: string) => {
              const cleanKey = k.replace(/%/g, '').toLowerCase();
              if (cleanKey.length < 2) return; 

              if (nameLower.includes(cleanKey)) {
                  score += 30; // Keyword in Name is worth more
                  matchedKeywords++;
              } else if (contentLower.includes(cleanKey)) {
                  score += 10; // Keyword in Content
                  matchedKeywords++;
              }
          });

          // D. Keyword Density Bonus (If multiple keywords match, it's likely relevant)
          if (matchedKeywords >= keywords.length && keywords.length > 1) score += 40;

          return { ...d, score };
      }).sort((a: any, b: any) => b.score - a.score);

      // Filter Noise: Only take docs with score > 15 (Must have at least partial match)
      // This prevents "random documents" from being included when score is 0.
      const topKeywordDocs = scoredDocs.filter((d: any) => d.score > 15).slice(0, 3);

      for (const d of topKeywordDocs) {
          seen.add(d.name);
          text += `[PRIORITY FILE MATCH]: "${d.name}" (Relevance Score: ${d.score})\n${processContent(d.extracted_content).substring(0, 30000)}\n---\n`;
      }

      // 3. SEMANTIC SEARCH (Fallback if embedding works)
      if (text.length < 100000 && vector.length > 0) {
          try {
              const queryResponse = await index.query({ vector, topK: 3, includeMetadata: true });
              for (const m of queryResponse.matches) {
                  const fname = m.metadata?.filename as string;
                  const existsInDb = Array.from(validFileNames).some(name => name.toLowerCase() === fname?.toLowerCase());

                  if (fname && existsInDb && !seen.has(fname)) {
                      // Avoid duplicates
                      const dbMatch = allDocs.find(d => d.name.toLowerCase() === fname.toLowerCase());
                      const content = dbMatch ? processContent(dbMatch.extracted_content) : String(m.metadata?.text || "");
                      
                      text += `[SEMANTIC MATCH]: "${fname}" (Score: ${m.score?.toFixed(2)})\n${content.substring(0, 20000)}\n---\n`;
                      seen.add(fname);
                  }
              }
          } catch (pe) { console.error("Pinecone query error", pe); }
      }
      return text;
    })();

    const context = await contextPromise;

    // 4. ADVANCED SYSTEM PROMPT
    const systemInstruction = `Bạn là Chuyên gia Phân tích Dữ liệu Doanh nghiệp (AI Senior Analyst).

NHIỆM VỤ:
Trả lời câu hỏi dựa trên Context được cung cấp.

QUY TẮC CHỐNG NHIỄU (ANTI-HALLUCINATION):
1. **Chỉ dùng đúng file**: Nếu câu hỏi về "Nội quy", chỉ trích xuất thông tin từ file có tiêu đề hoặc nội dung chứa "Nội quy". Bỏ qua các file khác trong Context nếu chúng không liên quan (ví dụ: file "Quy trình đăng ký làm thêm giờ" nếu không được hỏi).
2. **Không bịa đặt**: Nếu không tìm thấy thông tin chính xác trong Context, hãy nói: "Tôi đã tìm trong các tài liệu hiện có (ví dụ: [[File: ...]]) nhưng không thấy thông tin chi tiết bạn cần."
3. **Ưu tiên file điểm cao**: Các phần [PRIORITY FILE MATCH] có độ chính xác cao hơn [SEMANTIC MATCH].
4. **Trích dẫn bắt buộc**: Luôn dùng cú pháp [[File: Tên_File]] khi đưa ra thông tin.

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
