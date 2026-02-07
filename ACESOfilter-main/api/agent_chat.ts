
import { GoogleGenerativeAI } from "@google/generative-ai";
import { Annotation, StateGraph, START, END } from "@langchain/langgraph";
import { Pinecone } from '@pinecone-database/pinecone';
import { neon } from '@neondatabase/serverless';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { streamText } from 'ai';
import { google } from '@ai-sdk/google';

const execAsync = promisify(exec);

// --- Cấu hình Graph State ---
const AgentState = Annotation.Root({
  messages: Annotation<any[]>({ reducer: (x: any[], y: any[]) => x.concat(y), default: () => [] }),
  userQuery: Annotation<string>(),
  context: Annotation<string>({ reducer: (x: string, y: string) => x + "\n" + y, default: () => "" }),
  memories: Annotation<string>({ reducer: (x: string, y: string) => x + "\n" + y, default: () => "" }),
  decision: Annotation<string>(),
});

// --- Tools / Functions --

// Tạm thời comment out do lỗi "python3: command not found" trên Vercel Node.js runtime.
async function recallMemory(query: string): Promise<string> {
  console.warn("[Memory] RecallMemory is temporarily disabled in agent_chat.ts due to Python runtime issues.");
  return "";
  // try {
  //     const { stdout } = await execAsync(`python3 api/memory_bridge.py --action recall --query "${query.replace(/"/g, '\"')}"`);
  //     const result = JSON.parse(stdout);
  //     return result.answer || "";
  // } catch (e) {
  //     console.warn("[Memory Bridge] Recall failed", e);
  //     return "";
  // }
}

async function rememberConversation(conversation: string): Promise<any> {
  console.warn("[Memory] RememberConversation is temporarily disabled in agent_chat.ts due to Python runtime issues.");
  return null;
  // try {
  //     const { stdout } = await execAsync(`python3 api/memory_bridge.py --action remember --text "${conversation.replace(/"/g, '\"')}"`);
  //     return JSON.parse(stdout);
  // } catch (e) {
  //     console.warn("[Memory Bridge] Remember failed", e);
  //     return null;
  // }
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
            // Updated to use 'text-embedding-004' and correct format
            const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
            const result = await model.embedContent(query);
            const vector = result.embedding.values;

            const vRes = await index.query({ vector, topK: 3, includeMetadata: true });
            for (const match of vRes.matches) {
                contextText += `[SEMANTIC_FILE]: ${match.metadata?.filename}\n${match.metadata?.text}\n---\n`;
            }
        }
    } catch (e) {
        console.error("Knowledge search failed", e);
    }
    return contextText;
}

// --- Graph Nodes ---

const routerNode = async (state: typeof AgentState.State) => {
    const genAI = new GoogleGenerativeAI(process.env.API_KEY!);
    // Updated to use 'gemini-flash'
    const model = genAI.getGenerativeModel({ model: "gemini-flash" });

    const prompt = `Bạn là một Agent định tuyến. Quyết định hành động: "search_knowledge", "recall_memory", "both", "respond".
    User Query: "${state.userQuery}"`;

    const result = await model.generateContent(prompt);
    const decision = result.response.text().trim().toLowerCase();
    return { decision };
};

const retrieveMemoriesNode = async (state: typeof AgentState.State) => {
    const memories = await recallMemory(state.userQuery);
    return { memories };
};

const searchKnowledgeNode = async (state: typeof AgentState.State) => {
    const context = await searchKnowledgeBase(state.userQuery);
    return { context };
};

const respondNode = async () => ({});

// --- Xây dựng LangGraph --

const workflow = new StateGraph(AgentState)
    .addNode("router", routerNode)
    .addNode("retrieve_memories", retrieveMemoriesNode)
    .addNode("search_knowledge", searchKnowledgeNode)
    .addNode("respond_directly", respondNode)
    .addEdge(START, "router")
    .addConditionalEdges("router", (state) => state.decision, {
        "recall_memory": "retrieve_memories",
        "search_knowledge": "search_knowledge",
        "both": "retrieve_memories",
        "respond": "respond_directly",
    })
    .addEdge("retrieve_memories", "search_knowledge")
    .addEdge("search_knowledge", END)
    .addEdge("retrieve_memories", END)
    .addEdge("respond_directly", END);

const app = workflow.compile();

export default async function handler(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    try {
        const { messages } = req.body;
        const lastMessage = messages[messages.length - 1];
        const userQuery = lastMessage.content;

        const finalState = await app.invoke({ messages, userQuery });

        const result = await streamText({
            // Updated to use 'gemini-pro'
            model: google('gemini-pro'),
            system: `Bạn là ACESOfilter.
            MEMORIES: ${finalState.memories}
            CONTEXT: ${finalState.context}`,
            messages,
            onFinish: async ({ text }) => {
                await rememberConversation(`User: ${userQuery}\nAI: ${text}`);
            },
        });

        return result.toTextStreamResponse();
    } catch (error: any) {
        return res.status(500).json({ error: error.message });
    }
}
