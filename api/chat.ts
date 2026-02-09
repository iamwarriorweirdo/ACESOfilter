
import { Pinecone } from '@pinecone-database/pinecone';
import { GoogleGenAI } from '@google/genai';
import { neon } from '@neondatabase/serverless';
import Groq from "groq-sdk";
import type { VercelRequest, VercelResponse } from '@vercel/node';

async function getSafeEmbedding(ai: GoogleGenAI, text: string, configEmbeddingModel: string = 'text-embedding-004') {
    // 1. Try OpenAI if configured
    if (configEmbeddingModel.includes('text-embedding-3') && process.env.OPENAI_API_KEY) {
         try {
             const openAiRes = await fetch("https://api.openai.com/v1/embeddings", {
                 method: "POST",
                 headers: { 
                     "Content-Type": "application/json", 
                     "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` 
                 },
                 body: JSON.stringify({ model: configEmbeddingModel, input: text })
             });
             const data = await openAiRes.json();
             const vec = data.data?.[0]?.embedding;
             if (vec && vec.length > 0) return vec;
         } catch (oe) { console.error("OpenAI Embedding Error:", oe); }
    }

    // 2. Default/Fallback to Google
    try {
        const res = await ai.models.embedContent({
            model: "text-embedding-004",
            contents: [{ parts: [{ text }] }]
        });
        return res.embeddings?.[0]?.values || [];
    } catch (e: any) {
        console.error("[Chat RAG] Embedding Error (Google):", e.message);
        // 3. Final Fallback to OpenAI if Google fails (and wasn't tried first)
        if (!configEmbeddingModel.includes('text-embedding-3') && process.env.OPENAI_API_KEY) {
             try {
                 const openAiRes = await fetch("https://api.openai.com/v1/embeddings", {
                     method: "POST",
                     headers: { 
                         "Content-Type": "application/json", 
                         "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` 
                     },
                     body: JSON.stringify({ model: "text-embedding-3-small", input: text })
                 });
                 const data = await openAiRes.json();
                 return data.data?.[0]?.embedding || [];
             } catch (oe) { }
        }
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

// Simple OpenAI Fetch Wrapper to avoid 'openai' package dependency
async function queryOpenAI(messages: any[], model: string, res: VercelResponse) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Missing OPENAI_API_KEY");

    const openAiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model: model,
            messages: messages,
            stream: true
        })
    });

    if (!openAiResponse.ok) throw new Error(`OpenAI Error: ${openAiResponse.statusText}`);
    if (!openAiResponse.body) throw new Error("OpenAI: No response body");

    const reader = openAiResponse.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
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

    // Determine Model Preferences from Client Config
    const selectedModel = config?.aiModel || config?.chatModel || 'gemini-3-flash-preview';
    const embeddingModel = config?.embeddingModel || 'text-embedding-004';
    
    const isGroqModel = selectedModel.includes('llama') || selectedModel.includes('qwen') || selectedModel.includes('gemma');
    const isOpenAIModel = selectedModel.includes('gpt');

    const userQuery = lastMessage.content;
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || "" });
    
    // Database Setup
    const databaseUrl = process.env.DATABASE_URL;
    const pineconeApiKey = process.env.PINECONE_API_KEY;
    const pineconeIndexName = process.env.PINECONE_INDEX_NAME;
    let sql: any, index: any;

    if (databaseUrl && pineconeApiKey && pineconeIndexName) {
        sql = neon(databaseUrl.replace('postgresql://', 'postgres://'));
        const pc = new Pinecone({ apiKey: pineconeApiKey });
        index = pc.index(pineconeIndexName);
    }

    // 1. Retrieval (DB + Vector) - Only if DB configured
    const context = await (async () => {
      if (!sql || !index) return "";
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
        const vector = await getSafeEmbedding(ai, userQuery, embeddingModel);
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
    const fullMessages = [
        { role: 'system', content: systemInstruction },
        ...messages.map((m: any) => ({ role: m.role === 'assistant' || m.role === 'model' ? 'assistant' : 'user', content: m.content }))
    ];

    // 2. Generation Logic with Failover
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    
    const tryGemini = async () => {
        // Map user selected model to valid Gemini names
        let geminiModel = selectedModel;
        // Fallback for new keys if preview is restricted
        if (selectedModel === 'gemini-3-flash-preview') geminiModel = 'gemini-2.0-flash-exp'; 
        
        const chat = await ai.models.generateContentStream({
            model: geminiModel,
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
    };

    const tryGroq = async (modelName: string) => {
        const groqResponse = await groq.chat.completions.create({
            messages: fullMessages as any,
            model: modelName,
            stream: true,
        });
        for await (const chunk of groqResponse) {
            const content = chunk.choices[0]?.delta?.content || "";
            res.write(content);
        }
    };

    const tryOpenAI = async (modelName: string) => {
        await queryOpenAI(fullMessages, modelName, res);
    };

    // --- EXECUTION STRATEGY ---
    try {
        if (isOpenAIModel) {
             await tryOpenAI(selectedModel);
        } else if (isGroqModel) {
             await tryGroq(selectedModel);
        } else {
             await tryGemini();
        }
    } catch (primaryError: any) {
        console.warn(`Primary Model (${selectedModel}) Failed:`, primaryError.message);
        
        // --- FAILOVER CHAIN ---
        try {
            // Failover 1: Groq Llama 3.3 (Very Stable)
            res.write("\n\n[FAILOVER]: Model chính bận, chuyển sang Llama-3.3 (Groq)...\n\n");
            await tryGroq("llama-3.3-70b-versatile");
        } catch (groqError: any) {
            try {
                // Failover 2: OpenAI GPT-4o Mini (If key exists)
                if (process.env.OPENAI_API_KEY) {
                    res.write("\n\n[FAILOVER]: Groq bận, chuyển sang GPT-4o Mini...\n\n");
                    await tryOpenAI("gpt-4o-mini");
                } else {
                     throw new Error("No OpenAI Key for failover");
                }
            } catch (openAiError) {
                 // Failover 3: Hugging Face (Mistral) - Last Resort
                 console.warn("All primary/secondary failed, switching to Hugging Face.");
                 res.write("\n\n[CRITICAL FAILOVER]: Đang sử dụng Hugging Face Engine...\n\n");
                 const hfPrompt = `<s>[INST] ${systemInstruction}\n\nUser Question: ${userQuery} [/INST]`;
                 const hfText = await queryHuggingFace(hfPrompt);
                 res.write(hfText);
            }
        }
    }
    res.end();
  } catch (error: any) {
    if (!res.headersSent) res.status(500).json({ error: error.message });
    else { res.write(`\n\n[FATAL ERROR]: ${error.message}`); res.end(); }
  }
}
