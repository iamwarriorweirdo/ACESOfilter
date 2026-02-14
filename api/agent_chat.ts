import { GoogleGenAI } from "@google/genai";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { Pinecone } from '@pinecone-database/pinecone';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Định nghĩa State cho Agent
const AgentState = Annotation.Root({
  messages: Annotation<any[]>({ reducer: (x: any[], y: any[]) => x.concat(y), default: () => [] }),
  userQuery: Annotation<string>(),
  context: Annotation<string>({ reducer: (x: string, y: string) => x + "\n" + y, default: () => "" }),
});

async function retrieveContext(state: typeof AgentState.State) {
    const rawConnectionString = process.env.DATABASE_URL || '';
    const connectionString = rawConnectionString.replace('postgresql://', 'postgres://');
    let contextText = "";
    const query = state.userQuery;
    
    try {
        const sql = neon(connectionString);
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
        const index = pc.index(process.env.PINECONE_INDEX_NAME!);

        // Keyword Search
        const keywordMatches = await sql`
            SELECT name, extracted_content FROM documents 
            WHERE name ILIKE ${'%' + query + '%'} OR extracted_content ILIKE ${'%' + query + '%'}
            LIMIT 2
        `.catch(() => []);

        for (const doc of keywordMatches) {
            contextText += `[FILE]: ${doc.name}\n${doc.extracted_content?.substring(0, 1500)}\n---\n`;
        }

        // Semantic Search
        if (contextText.length < 1000) {
            const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
            const result = await ai.models.embedContent({
                model: "embedding-001",
                contents: [{ parts: [{ text: query }] }]
            });
            const vector = result.embeddings?.[0]?.values || [];

            if (vector.length > 0) {
                const vRes = await index.query({ vector, topK: 2, includeMetadata: true });
                for (const match of vRes.matches) {
                    contextText += `[VECTOR MATCH]: ${match.metadata?.filename}\n${match.metadata?.text}\n---\n`;
                }
            }
        }
    } catch (e) { console.error("Agent Retrieval Error", e); }

    return { context: contextText };
}

async function generateAnswer(state: typeof AgentState.State) {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

    const prompt = `Bạn là Trợ lý HR AI cấp cao. 
    Dựa trên dữ liệu tài liệu sau:
    ${state.context || "Không tìm thấy tài liệu liên quan trong hệ thống."}

    Hãy trả lời câu hỏi của người dùng một cách chuyên nghiệp và chính xác nhất: ${state.userQuery}`;

    const result = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt
    });
    return { messages: [{ role: "assistant", content: result.text || "Xin lỗi, tôi không thể tạo phản hồi lúc này." }] };
}

// Xây dựng đồ thị workflow
const workflow = new StateGraph(AgentState)
    .addNode("retrieve", retrieveContext)
    .addNode("respond", generateAnswer)
    .addEdge(START, "retrieve")
    .addEdge("retrieve", "respond")
    .addEdge("respond", END);

const app = workflow.compile();

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).end();
    
    try {
        const { messages } = req.body;
        const lastUserMessage = messages[messages.length - 1].content;

        const result = await app.invoke({
            userQuery: lastUserMessage,
            messages: messages
        });

        const finalMsg = result.messages[result.messages.length - 1];
        return res.status(200).json({ content: finalMsg.content });
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
}