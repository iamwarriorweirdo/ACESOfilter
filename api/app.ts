
import { neon } from '@neondatabase/serverless';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';

// Fallback logic for various Vercel Database Integrations (Neon, Supabase, Postgres)
const rawConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;

async function getSql() {
    if (!rawConnectionString) {
        throw new Error("Server chưa được cấu hình Database. Vui lòng kiểm tra DATABASE_URL hoặc POSTGRES_URL.");
    }
    const connectionString = rawConnectionString.replace('postgresql://', 'postgres://').trim();
    return neon(connectionString);
}

// Resolve env var by exact name or by suffix/contains (Vercel/Supabase integration có thể thêm prefix)
function getSupabaseEnv(suffix: string, isUrl = false): string | undefined {
    const exact = process.env[suffix]?.trim();
    if (exact) return exact;
    const upper = suffix.toUpperCase();
    for (const [k, v] of Object.entries(process.env)) {
        if (!v || typeof v !== 'string') continue;
        const val = v.trim();
        if (!val) continue;
        const ku = k.toUpperCase();
        if (ku === upper || ku.endsWith('_' + upper) || ku.includes(upper)) {
            if (isUrl && !val.startsWith('http')) continue;
            return val;
        }
    }
    return undefined;
}

async function handleUsers(req: VercelRequest, res: VercelResponse) {
    if (req.method?.toUpperCase() !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    const { action, username, password, role, createdBy } = body;

    if (action === 'login') {
        const sysAdminUser = process.env.ADMIN_USER || 'Admin';
        const sysAdminPass = process.env.ADMIN_PASS || 'Admin123@';
        if (username === sysAdminUser && password === sysAdminPass) return res.status(200).json({ success: true, user: { username: sysAdminUser, role: 'superadmin' } });
        try {
            const sql = await getSql();
            await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
            const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
            if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
        } catch (e: any) {
            return res.status(500).json({ error: `Lỗi Database: ${e.message}` });
        }
        return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu." });
    }
    if (action === 'create') {
        if (!username || !password) return res.status(400).json({ error: 'Thiếu username hoặc password.' });
        try {
            const sql = await getSql();
            await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
            const roleVal = (role === 'superadmin' || role === 'it' || role === 'hr' || role === 'employee') ? role : 'employee';
            await sql`INSERT INTO users (username, password, role, created_at, created_by) VALUES (${username}, ${password}, ${roleVal}, ${Date.now()}, ${createdBy || 'system'}) ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role`;
            return res.status(200).json({ success: true });
        } catch (e: any) {
            return res.status(500).json({ error: `Lỗi tạo tài khoản: ${e.message}` });
        }
    }
    if (action === 'list') {
        try {
            const sql = await getSql();
            await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
            const rows = await sql`SELECT username, role, created_at, created_by FROM users ORDER BY username`;
            return res.status(200).json({ users: rows });
        } catch (e: any) {
            return res.status(500).json({ error: `Lỗi Database: ${e.message}` });
        }
    }
    if (action === 'delete') {
        if (!username) return res.status(400).json({ error: 'Thiếu username.' });
        try {
            const sql = await getSql();
            await sql`DELETE FROM users WHERE username = ${username}`;
            return res.status(200).json({ success: true });
        } catch (e: any) {
            return res.status(500).json({ error: `Lỗi xóa: ${e.message}` });
        }
    }
    return res.status(400).json({ error: "Invalid action" });
}

async function handleFiles(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    await sql`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, content TEXT, url TEXT, size BIGINT, upload_date BIGINT, extracted_content TEXT, folder_id TEXT, uploaded_by TEXT)`;

    const method = req.method?.toUpperCase();
    if (method === 'GET') {
        const docs = await sql`SELECT * FROM documents ORDER BY upload_date DESC`;
        const mappedDocs = docs.map((d: any) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            content: d.content || d.url,
            url: d.url || d.content,
            size: Number(d.size),
            uploadDate: Number(d.upload_date),
            extractedContent: d.extracted_content || "",
            status: d.extracted_content && d.extracted_content.startsWith('{') ? 'Thành công (Indexed)' : (d.extracted_content || "Đang chờ xử lý"),
            folderId: d.folder_id || null,
            uploadedBy: d.uploaded_by || 'system'
        }));
        return res.status(200).json(mappedDocs);
    }
    if (method === 'POST') {
        let doc = req.body || {};
        if (typeof doc === 'string') { try { doc = JSON.parse(doc); } catch (e) { } }
        if (doc.extractedContent && !doc.name) {
            await sql`UPDATE documents SET extracted_content = ${doc.extractedContent} WHERE id = ${doc.id}`;
            return res.status(200).json({ success: true });
        }
        await sql`
            INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content) 
            VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}) 
            ON CONFLICT (id) DO UPDATE SET 
                url = EXCLUDED.url, 
                content = EXCLUDED.content,
                extracted_content = EXCLUDED.extracted_content,
                folder_id = EXCLUDED.folder_id
        `;
        return res.status(200).json({ success: true });
    }
    if (method === 'DELETE') {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }

        const docId = body.id;
        if (!docId) return res.status(400).json({ error: 'Missing document ID' });

        // 1. Fetch document metadata to get file URL
        const docs = await sql`SELECT * FROM documents WHERE id = ${docId}`;
        if (docs.length === 0) {
            return res.status(404).json({ error: 'Document not found' });
        }

        const doc = docs[0];
        const fileUrl = doc.url || doc.content;
        const fileName = doc.name;

        console.log(`[DELETE] Starting deletion for: ${fileName} (ID: ${docId})`);

        // 2. Delete from Cloudinary (if file is hosted there)
        if (fileUrl && fileUrl.includes('cloudinary.com')) {
            try {
                const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
                const apiKey = process.env.CLOUDINARY_API_KEY?.trim();
                const apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

                if (cloudName && apiKey && apiSecret) {
                    const urlParts = fileUrl.split('/');
                    const uploadIndex = urlParts.findIndex(p => p === 'upload');
                    if (uploadIndex !== -1 && uploadIndex + 2 < urlParts.length) {
                        const publicIdWithExt = urlParts.slice(uploadIndex + 2).join('/');
                        const parts = publicIdWithExt.split('.');
                        if (parts.length > 1) parts.pop(); 
                        const publicId = parts.join('.');

                        console.log(`[DELETE] Deleting from Cloudinary: ${publicId}`);
                        await cloudinary.uploader.destroy(publicId, { invalidate: true });
                    }
                }
            } catch (e: any) {
                console.error(`[DELETE] Cloudinary deletion failed:`, e.message);
            }
        }

        // 3. Delete from Supabase (if file is hosted there)
        if (fileUrl && fileUrl.includes('supabase.co')) {
            try {
                const supabaseUrl = getSupabaseEnv('SUPABASE_URL', true) || process.env.SUPABASE_URL?.trim();
                const supabaseKey = getSupabaseEnv('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

                if (supabaseUrl && supabaseKey) {
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    const urlParts = fileUrl.split('/documents/');
                    if (urlParts.length === 2) {
                        const filePath = urlParts[1];
                        console.log(`[DELETE] Deleting from Supabase: ${filePath}`);
                        await supabase.storage.from('documents').remove([filePath]);
                    }
                }
            } catch (e: any) {
                console.error(`[DELETE] Supabase deletion failed:`, e.message);
            }
        }

        // 4. Delete from Pinecone
        try {
            const pineconeApiKey = process.env.PINECONE_API_KEY;
            const pineconeIndexName = process.env.PINECONE_INDEX_NAME;

            if (pineconeApiKey && pineconeIndexName) {
                const { Pinecone } = await import('@pinecone-database/pinecone');
                const pc = new Pinecone({ apiKey: pineconeApiKey });
                const index = pc.index(pineconeIndexName);
                console.log(`[DELETE] Deleting from Pinecone: ${docId}`);
                await index.deleteOne(docId);
            }
        } catch (e: any) {
            console.error(`[DELETE] Pinecone deletion failed:`, e.message);
        }

        // 5. Delete metadata from Neon Database
        await sql`DELETE FROM documents WHERE id = ${docId}`;
        console.log(`[DELETE] Successfully deleted document: ${fileName}`);

        return res.status(200).json({ success: true, message: `File deleted from all storage systems` });
    }
    return res.status(405).end();
}

async function handleUploadSupabase(req: VercelRequest, res: VercelResponse) {
    try {
        const supabaseUrl = getSupabaseEnv('SUPABASE_URL', true)
            || getSupabaseEnv('NEXT_PUBLIC_SUPABASE_URL', true)
            || process.env.SUPABASE_URL?.trim()
            || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
        const supabaseKey = getSupabaseEnv('SUPABASE_SERVICE_ROLE_KEY')
            || getSupabaseEnv('SUPABASE_SERVICE_KEY')
            || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
            || process.env.SUPABASE_SERVICE_KEY?.trim();

        if (!supabaseUrl || !supabaseKey) {
            console.error("Missing Supabase env vars.");
            return res.status(500).json({ error: 'Server thiếu cấu hình Supabase.' });
        }

        const supabase = createClient(supabaseUrl, supabaseKey);

        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
        const { filename } = body;
        if (!filename) return res.status(400).json({ error: "Missing filename" });

        // Ensure bucket exists
        try {
            const { data: buckets } = await supabase.storage.listBuckets();
            const bucketExists = buckets?.find(b => b.name === 'documents');
            if (!bucketExists) {
                await supabase.storage.createBucket('documents', { public: true });
            }
        } catch (e) { console.warn("Bucket check failed", e); }

        const uniqueFileName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        const { data, error } = await supabase.storage.from('documents').createSignedUploadUrl(uniqueFileName);

        if (error) return res.status(500).json({ error: `Supabase Sign Error: ${error.message}` });
        if (!data || !data.signedUrl) return res.status(500).json({ error: "Supabase did not return a signed URL." });

        const { data: publicData } = supabase.storage.from('documents').getPublicUrl(uniqueFileName);
        return res.status(200).json({ uploadUrl: data.signedUrl, publicUrl: publicData.publicUrl });
    } catch (err: any) {
        console.error("Supabase Handler Critical Error:", err);
        return res.status(500).json({ error: `Supabase Critical Error: ${err.message}` });
    }
}

async function handleFolders(req: VercelRequest, res: VercelResponse) {
    if (req.method?.toUpperCase() !== 'POST') return res.status(405).json({ error: "Method Not Allowed" });
    const sql = await getSql();
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    const { action } = body;
    await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
    if (action === 'list') {
        const folders = await sql`SELECT * FROM app_folders ORDER BY name ASC`;
        return res.status(200).json({ folders: folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) })) });
    }
    if (action === 'create') {
        const { id, name, parentId } = body;
        await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${id}, ${name}, ${parentId || null}, ${Date.now()})`;
        return res.status(200).json({ success: true });
    }
    if (action === 'update') {
        const { id, name } = body;
        if (!id || !name) return res.status(400).json({ error: "Missing ID or Name" });
        await sql`UPDATE app_folders SET name = ${name} WHERE id = ${id}`;
        return res.status(200).json({ success: true });
    }
    if (action === 'delete') {
        const { id } = body;
        if (!id) return res.status(400).json({ error: "Missing ID" });
        await sql`DELETE FROM app_folders WHERE id = ${id}`;
        return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Invalid Action" });
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    let { handler } = req.query;
    // Normalize handler if it's an array (query param repetition)
    if (Array.isArray(handler)) handler = handler[0];
    
    // Normalize casing
    const action = handler ? String(handler).toLowerCase() : null;

    try {
        if (!action) {
             // Return 200 to prevent 404s if people hit root /api/app
             return res.status(200).json({ status: "API Ready", message: "No handler specified" });
        }

        if (action === 'users') return await handleUsers(req, res);
        if (action === 'files') return await handleFiles(req, res);
        if (action === 'folders') return await handleFolders(req, res);
        if (action === 'upload-supabase') return await handleUploadSupabase(req, res);
        if (action === 'sign-cloudinary') {
            let cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
            let apiKey = process.env.CLOUDINARY_API_KEY?.trim();
            let apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();

            if ((!cloudName || !apiKey || !apiSecret) && process.env.CLOUDINARY_URL) {
                try {
                    const matches = process.env.CLOUDINARY_URL.trim().match(/^cloudinary:\/\/([^:]+):([^@]+)@(.*)$/);
                    if (matches) {
                        apiKey = matches[1];
                        apiSecret = matches[2];
                        cloudName = matches[3];
                    }
                } catch (e) { console.error("Lỗi phân tích CLOUDINARY_URL:", e); }
            }

            if (!cloudName || !apiKey || !apiSecret) {
                return res.status(500).json({ error: `Server thiếu cấu hình Cloudinary.` });
            }

            const timestamp = Math.round(new Date().getTime() / 1000);
            const signature = cloudinary.utils.api_sign_request({ folder: 'ACESOfilter', timestamp }, apiSecret!);
            return res.status(200).json({ signature, apiKey, cloudName, timestamp, folder: 'ACESOfilter' });
        }

        if (action === 'analytics' || action === 'usage') {
            try {
                const sql = await getSql();
                await sql`CREATE TABLE IF NOT EXISTS token_usage (id TEXT PRIMARY KEY, model TEXT, tokens INTEGER, duration_ms INTEGER, status TEXT, timestamp BIGINT, error_msg TEXT)`;
                
                // Parse filters
                let body = req.body || {};
                if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
                const { startDate, endDate, model } = body;

                let query;
                if (startDate && endDate && model && model !== 'all') {
                    query = await sql`SELECT * FROM token_usage WHERE timestamp >= ${startDate} AND timestamp <= ${endDate} AND model ILIKE ${`%${model}%`} ORDER BY timestamp DESC LIMIT 100`;
                } else if (startDate && endDate) {
                    query = await sql`SELECT * FROM token_usage WHERE timestamp >= ${startDate} AND timestamp <= ${endDate} ORDER BY timestamp DESC LIMIT 100`;
                } else {
                    query = await sql`SELECT * FROM token_usage ORDER BY timestamp DESC LIMIT 100`;
                }

                const data = query;
                const summary = {
                    totalRequests: data.length,
                    totalTokens: data.reduce((sum: number, r: any) => sum + (r.tokens || 0), 0),
                    avgLatency: data.length > 0 ? Math.round(data.reduce((sum: number, r: any) => sum + (r.duration_ms || 0), 0) / data.length) : 0,
                    totalErrors: data.filter((r: any) => r.status === 'error').length
                };

                const modelStats: Record<string, any> = {};
                const dayStats: Record<string, any> = {};
                for (const row of data) {
                    const m = row.model || 'unknown';
                    if (!modelStats[m]) modelStats[m] = { model: m, requests: 0, errors: 0 };
                    modelStats[m].requests++;
                    if (row.status === 'error') modelStats[m].errors++;

                    const day = new Date(Number(row.timestamp)).toISOString().split('T')[0];
                    if (!dayStats[day]) dayStats[day] = { day, requests: 0 };
                    dayStats[day].requests++;
                }

                return res.status(200).json({
                    data: Object.values(modelStats), 
                    recentLogs: data.slice(0, 50),
                    summary,
                    trend: Object.values(dayStats).sort((a: any, b: any) => a.day.localeCompare(b.day))
                });
            } catch (e: any) {
                return res.status(200).json({ data: [], recentLogs: [], summary: {}, trend: [] });
            }
        }

        if (action === 'config') {
            try {
                const sql = await getSql();
                await sql`CREATE TABLE IF NOT EXISTS system_settings (id TEXT PRIMARY KEY, data TEXT)`;

                if (req.method === 'POST') {
                    let body = req.body || {};
                    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
                    await sql`INSERT INTO system_settings (id, data) VALUES ('global', ${JSON.stringify(body)}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
                    return res.status(200).json({ success: true });
                } else {
                    const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
                    if (rows.length > 0) {
                        return res.status(200).json(JSON.parse(rows[0].data));
                    }
                    return res.status(200).json({}); 
                }
            } catch (e: any) {
                return res.status(500).json({ error: `Config Error: ${e.message}` });
            }
        }

        return res.status(404).json({ error: `Handler '${action}' not found` });
    } catch (e: any) {
        console.error("API Handler Error:", e);
        return res.status(500).json({ error: e.message || "Lỗi Server không xác định" });
    }
}
