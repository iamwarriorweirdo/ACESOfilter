import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import Groq from "groq-sdk";
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { redactPII } from '../utils/textProcessor';

async function getSafeEmbedding(ai: GoogleGenAI, text: string, configEmbeddingModel: string = 'embedding-001') {
    const openAiKey = process.env.OPEN_AI_API_KEY;
    if (configEmbeddingModel && configEmbeddingModel.includes('text-embedding-3') && openAiKey) {
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
            model: "embedding-001",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.warn(`Gemini embedding failed: ${e.message}.`);
        return [];
    }
}

async function logChatToDb(sql: any, user: any, messages: any[], title: string) {
    if (!user || !user.username) return;
    try {
        // Find existing session or create new
        // Ideally we pass sessionId from frontend, but for now we handle simple history update
        // We will simple store the latest conversation state in a "history" log table
        // Or if we have a session ID, update it.
        const shortHistory = JSON.stringify(messages.slice(-10)); // Keep last 10 msgs
        const sessionId = `${user.username}_${new Date().toISOString().split('T')[0]}`; // Daily session
        
        // Simple append log for auditing
        await sql`CREATE TABLE IF NOT EXISTS chat_history (id TEXT PRIMARY KEY, user_id TEXT, title TEXT, messages TEXT, created_at BIGINT)`;
        
        // Upsert session
        await sql`INSERT INTO chat_history (id, user_id, title, messages, created_at)
                  VALUES (${sessionId}, ${user.username}, ${title}, ${shortHistory}, ${Date.now()})
                  ON CONFLICT (id) DO UPDATE SET messages = ${shortHistory}, created_at = ${Date.now()}`;
    } catch (e) { console.error("Chat logging failed", e); }
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
    const { messages, config, user } = req.body; // Expecting user object with role
    const lastMessage = messages?.[messages.length - 1];
    if (!lastMessage) return res.status(400).json({ error: "No messages" });

    // 1. PII Redaction on User Query (Protect sensitive info in logs/LLM)
    const userQuery = redactPII(lastMessage.content);
    
    // 2. Identify User Role for RBAC
    const userRole = user?.role || 'employee'; // Default to lowest privilege

    let inputModel = config?.chatModel || 'auto';
    let selectedModel = 'gemini-3-flash-preview';
    if (inputModel === 'auto') {
        const isComplex = userQuery.length > 500 || messages.length > 5;
        selectedModel = isComplex ? 'gemini-3-pro-preview' : 'gemini-3-flash-preview';
    } else {
        selectedModel = inputModel;
    }

    const embeddingModel = config?.embeddingModel || 'embedding-001';
    
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
                  return `Title: ${data.title}\nSummary: ${data.summary}\nFull Text: ${data.full_text_content || ""}`;
              }
          } catch (e) { }
          return raw;
      };

      const keywords = userQuery.split(/\s+/).filter((w: string) => w.length > 2).map((w: string) => `%${w}%`);
      
      // SQL Keyword Search needs to respect RBAC too
      // Unfortunately storing RBAC in SQL for simple docs table is done via JSON text column 'allowed_roles'
      // Neon/Postgres JSON query: 
      const validDocsPromise = sql`
        SELECT name, extracted_content, allowed_roles 
        FROM documents 
        WHERE allowed_roles ILIKE ${'%' + userRole + '%'} OR allowed_roles ILIKE '%all%' OR allowed_roles IS NULL
      `; 
      
      const vectorPromise = getSafeEmbedding(ai, userQuery, embeddingModel);

      const [allDocs, vector] = await Promise.all([validDocsPromise, vectorPromise]);
      const validFileNames = new Set(allDocs.map(d => d.name));

      // --- HYBRID SEARCH LOGIC ---

      // 1. Keyword Scoring
      const scoredDocs = allDocs.map((d: any) => {
          let score = 0;
          // Basic keyword match logic
          const contentStr = typeof d.extracted_content === 'string' ? d.extracted_content.toLowerCase() : "";
          const nameLower = d.name.toLowerCase();
          const queryLower = userQuery.toLowerCase();
          
          if (nameLower.includes(queryLower)) score += 200;
          if (contentStr.includes(queryLower)) score += 50;
          
          keywords.forEach((k: string) => {
              const cleanKey = k.replace(/%/g, '').toLowerCase();
              if (cleanKey.length < 2) return; 
              if (nameLower.includes(cleanKey)) score += 30;
              else if (contentStr.includes(cleanKey)) score += 10;
          });
          return { ...d, score };
      }).sort((a: any, b: any) => b.score - a.score);

      const topKeywordDocs = scoredDocs.filter((d: any) => d.score > 15).slice(0, 3);
      for (const d of topKeywordDocs) {
          seen.add(d.name);
          text += `[PRIORITY FILE MATCH]: "${d.name}" (Score: ${d.score})\n${processContent(d.extracted_content).substring(0, 15000)}\n---\n`;
      }

      // 2. Vector Search with RBAC Filter
      if (text.length < 50000 && vector.length > 0) {
          try {
              // RBAC FILTER: Only fetch chunks where allowed_roles contains userRole
              const filter = {
                  allowed_roles: { $in: [userRole, 'all', 'employee'] } // 'employee' is usually base, add dynamic if needed
              };

              const queryResponse = await index.query({ 
                  vector, 
                  topK: 5, 
                  includeMetadata: true,
                  filter: filter // APPLY FILTER
              });

              for (const m of queryResponse.matches) {
                  const fname = m.metadata?.filename as string;
                  // Ensure file exists in our SQL allow-list (double check)
                  if (fname && validFileNames.has(fname) && !seen.has(fname)) {
                      const content = m.metadata?.text || "";
                      text += `[SEMANTIC MATCH]: "${fname}" (Score: ${m.score?.toFixed(2)})\n${content}\n---\n`;
                      seen.add(fname);
                  } else if (m.metadata?.text && !seen.has(fname)) {
                      // Chunk match, might correspond to a doc
                      text += `[SEMANTIC CHUNK]: "${fname}"\n${m.metadata.text}\n---\n`;
                  }
              }
          } catch (pe) { console.error("Pinecone query error", pe); }
      }
      return text;
    })();

    const context = await contextPromise;

    // 3. System Instruction
    const systemInstruction = `Bạn là Chuyên gia Phân tích Dữ liệu Doanh nghiệp (AI Senior Analyst).
    
NGƯỜI DÙNG: ${user?.username} (Role: ${userRole}).
NHIỆM VỤ: Trả lời câu hỏi dựa trên Context được cung cấp.

QUY TẮC BẢO MẬT & CHỐNG NHIỄU:
1. **Dữ liệu PII**: Tôi đã tự động ẩn danh Email/SĐT trong câu hỏi. Nếu trong Context có chứa SĐT/Email thật, hãy giữ nguyên hoặc che đi tùy ngữ cảnh, nhưng không được bịa ra thông tin liên lạc.
2. **Chỉ dùng đúng file**: Trích xuất thông tin từ file liên quan nhất.
3. **Trích dẫn**: Luôn dùng cú pháp [[File: Tên_File]] khi đưa ra thông tin.

Context Dữ Liệu:
${context || "Không tìm thấy dữ liệu nào khớp với câu hỏi (hoặc bạn không có quyền truy cập)."}`;

    // 4. Generate Response
    if (selectedModel && selectedModel.includes('gpt')) {
        await queryOpenAI([{ role: 'system', content: systemInstruction }, ...messages], selectedModel, res);
    } else if (selectedModel && (selectedModel.includes('llama') || selectedModel.includes('qwen'))) {
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
    
    // 5. Audit Logging (Async)
    const title = userQuery.substring(0, 50) + "...";
    logChatToDb(sql, user, messages, title);

    res.end();
  } catch (error: any) {
    console.error("Chat Error:", error);
    if (!res.headersSent) {
        res.status(500).json({ error: error.message || "Internal Server Error" });
    } else {
        res.write(`\n\n[Lỗi hệ thống]: ${error.message}`);
        res.end();
    }
  }
}
