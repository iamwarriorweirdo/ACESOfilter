
import { Pinecone } from '@pinecone-database/pinecone';
import { neon } from '@neondatabase/serverless';
import 'dotenv/config';

async function cleanupGhostData() {
    console.log("--- STARTING PINE-DB SYNC CLEANUP ---");

    try {
        // 1. Setup DB
        const rawConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
        if (!rawConnectionString) throw new Error("Missing DATABASE_URL");
        const sql = neon(rawConnectionString.replace('postgresql://', 'postgres://'));

        // 2. Setup Pinecone
        if (!process.env.PINECONE_API_KEY || !process.env.PINECONE_INDEX_NAME) {
            throw new Error("Missing Pinecone credentials");
        }
        const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        const index = pc.index(process.env.PINECONE_INDEX_NAME);

        // 3. Fetch all DB IDs
        console.log("Fetching IDs from Database...");
        const dbDocs = await sql`SELECT id FROM documents`;
        const dbIdSet = new Set(dbDocs.map((d: any) => d.id));
        console.log(`Found ${dbIdSet.size} documents in DB.`);

        // 4. Fetch Pinecone IDs (using listPaginated for scale)
        console.log("Fetching IDs from Pinecone...");
        let pineconeIds: string[] = [];
        const listResults = await index.listPaginated();
        if (listResults.vectors) {
            pineconeIds = listResults.vectors.map(v => v.id || '');
        }
        console.log(`Found ${pineconeIds.length} vectors in Pinecone.`);

        // 5. Identify Orphans
        const orphans = pineconeIds.filter(id => id && !dbIdSet.has(id));
        console.log(`Identified ${orphans.length} ghost/orphan vectors.`);

        if (orphans.length === 0) {
            console.log("✅ Everything is synced. No orphans found.");
            return;
        }

        // 6. Cleanup
        console.log("Cleaning up orphans...");
        for (const id of orphans) {
            process.stdout.write(`Deleting ${id}... `);
            await index.deleteMany([id]);
            console.log("Done.");
        }

        console.log(`\n✅ Cleanup complete. Deleted ${orphans.length} orphan vectors.`);

    } catch (e: any) {
        console.error("❌ Cleanup Failed:", e.message || e);
    }
}

cleanupGhostData();
