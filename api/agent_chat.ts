
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { Pinecone } from '@pinecone-database/pinecone';
import { neon } from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { streamText } from 'ai';
import { google } from '@ai-sdk/google';

const AgentState = Annotation.Root({
  messages: Annotation<any[]>({ reducer: (x: any[], y: any[]) => x.concat(y), default: () => [] }),
  userQuery: Annotation<string>(),
  context: Annotation<string>({ reducer: (x: string, y: string) => x + "\n" + y, default: () => "" }),
  memories: Annotation<string>({ reducer: (x: string, y: string) => x + "\n" + y, default: () => "" }),
  decision: Annotation<string>(),
});

async function recallMemory(query: string, baseUrl: string): Promise<string> {
  try {
    const response = await fetch(`${baseUrl}/api/memory?action=recall&query=${encodeURIComponent(query)}`);
    if (response.ok) {
        const data = await response.json();
        return data.answer || "";
    }
  } catch (e) {}
  return "";
}

async function rememberConversation(conversation: string, baseUrl: string): Promise<any> {
  try {
    fetch(`${baseUrl}/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remember', text: conversation })
    }).catch(() => {});
  } catch (e) {}
}

async function searchKnowledgeBase(query: string): Promise<string> {
    const rawConnectionString = process.env.DATABASE_URL || '';
    const connectionString = rawConnectionString.replace('postgresql://', 'postgres://');
    let contextText = "";
    
    try {
        const sql = neon(connectionString);
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
        const index = pc.index(process.env.PINECONE_INDEX_NAME!);

        const keywordMatches = await sql`
            SELECT name, extracted_content 
            FROM documents 
            WHERE name ILIKE ${'%' + query + '%'} OR extracted_content ILIKE ${'%' + query + '%'}
            LIMIT 3
        `;

        for (const doc of keywordMatches) {
            contextText += `[FILE]: ${doc.name}\n${doc.extracted_content?.substring(0, 2000)}\n---\n`;
        }

        if (contextText.length < 2000) {
            const genAI = new GoogleGenerativeAI(process.env.API_KEY!);
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const result = await model.embedContent(query);
            const vector = result.embedding.values;

            const vRes = await index.query({ vector, topK: 3, includeMetadata: true });
            for (const match of vRes.matches) {
                contextText += `[SEMANTIC_FILE]: ${match.metadata?.filename}\n${match.metadata?.text}\n---\n`;
            }
        }
    } catch (e) {}
    return contextText;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { messages } = req.body;
        const lastMessage = messages[messages.length - 1];
        const userQuery = lastMessage.content;
        const baseUrl = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['host']}`;

        // Agent logic: Parallel search
        const [context, memories] = await Promise.all([
            searchKnowledgeBase(userQuery),
            recallMemory(userQuery, baseUrl)
        ]);

        const result = await streamText({
            model: google('gemini-2.0-flash-exp'),
            system: `Bạn là ACESOfilter. Sử dụng dữ liệu dưới đây:
            KÝ ỨC (Hội thoại cũ): ${memories}
            KIẾN THỨC (Tài liệu): ${context}`,
            messages,
            onFinish: async ({ text }) => {
                await rememberConversation(`User: ${userQuery}\nAI: ${text}`, baseUrl);
            },
        });

        return result.toTextStreamResponse();
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
}
