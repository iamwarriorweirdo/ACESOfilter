import { neon } from '@neondatabase/serverless';
import { v2 as cloudinary } from 'cloudinary';
import { createClient } from '@supabase/supabase-js';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Inngest } from 'inngest';
import { Buffer } from 'node:buffer';

const inngest = new Inngest({ id: "hr-rag-app" });

const rawConnectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_POSTGRES_URL;

async function getSql() {
    if (!rawConnectionString) {
        throw new Error("Server chưa được cấu hình Database. Vui lòng kiểm tra DATABASE_URL hoặc POSTGRES_URL.");
    }
    const connectionString = rawConnectionString.replace('postgresql://', 'postgres://').trim();
    return neon(connectionString);
}

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

// --- MERGED HANDLERS ---

async function handleUsers(req: VercelRequest, res: VercelResponse) {
    if (req.method?.toUpperCase() !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    const { action, username, password, role, createdBy } = body;

    if (action === 'login') {
        const sysAdminUser = (process.env.ADMIN_USER || process.env.ADMIN_USERNAME || '').trim();
        const sysAdminPass = (process.env.ADMIN_PASS || process.env.ADMIN_PASSWORD || '').trim();
        const inputUser = (username || '').trim();
        const inputPass = (password || '').trim();

        if (!sysAdminPass) console.error("CRITICAL: ADMIN_PASSWORD environment variable is NOT SET.");
        else if (sysAdminUser && inputUser.toLowerCase() === sysAdminUser.toLowerCase()) {
            if (inputPass === sysAdminPass) {
                return res.status(200).json({ success: true, user: { username: sysAdminUser, role: 'superadmin' } });
            }
        }
        
        try {
            const sql = await getSql();
            // Optimistic query - assume table exists to save time. If fails, create and retry.
            try {
                const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
                if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
            } catch (e) {
                await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
                const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
                if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
            }
        } catch (e: any) {
            return res.status(500).json({ error: `Lỗi Database: ${e.message}` });
        }
        return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu." });
    }
    
    // For other actions (create, list), we can keep the safety checks as they are less frequent
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
    return res.status(400).json({ error: "Invalid action" });
}

async function handleFiles(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    
    // REMOVED: Expensive DDL checks (CREATE TABLE / ALTER TABLE) from every request.
    // We assume table exists. If not, the first insert will fail, caught, and then we create.
    
    const method = req.method?.toUpperCase();
    if (method === 'GET') {
        const { id } = req.query;
        if (id) {
            const rows = await sql`SELECT id, name, extracted_content FROM documents WHERE id = ${id}`;
            if (rows.length === 0) return res.status(404).json({ error: "File not found" });
            return res.status(200).json(rows[0]);
        }

        const docs = await sql`SELECT id, name, type, content, url, size, upload_date, folder_id, uploaded_by, status FROM documents ORDER BY upload_date DESC`;
        const mappedDocs = docs.map((d: any) => ({
            id: d.id,
            name: d.name,
            type: d.type,
            content: d.content || d.url,
            url: d.url || d.content,
            size: Number(d.size),
            uploadDate: Number(d.upload_date),
            status: d.status || 'pending',
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

        try {
            await sql`
                INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content, status) 
                VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}, ${doc.status || 'pending'}) 
                ON CONFLICT (id) DO UPDATE SET 
                    url = EXCLUDED.url, 
                    content = EXCLUDED.content,
                    extracted_content = EXCLUDED.extracted_content,
                    folder_id = EXCLUDED.folder_id,
                    status = EXCLUDED.status
            `;
        } catch (e: any) {
            // Fallback: If table doesn't exist, create it and retry.
            if (e.message && (e.message.includes('relation "documents" does not exist') || e.message.includes('column'))) {
                await sql`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, content TEXT, url TEXT, size BIGINT, upload_date BIGINT, extracted_content TEXT, folder_id TEXT, uploaded_by TEXT)`;
                try { await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT`; } catch (_) { }
                
                // Retry Insert
                await sql`
                    INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content, status) 
                    VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}, ${doc.status || 'pending'}) 
                    ON CONFLICT (id) DO UPDATE SET 
                        url = EXCLUDED.url, 
                        content = EXCLUDED.content,
                        extracted_content = EXCLUDED.extracted_content,
                        folder_id = EXCLUDED.folder_id,
                        status = EXCLUDED.status
                `;
            } else {
                throw e;
            }
        }
        return res.status(200).json({ success: true });
    }

    if (method === 'DELETE') {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
        const docId = body.id;
        if (!docId) return res.status(400).json({ error: 'Missing document ID' });

        try {
            // STEP 1: Fetch URL to trigger cleanup (Supabase/Cloudinary/Pinecone)
            const rows = await sql`SELECT id, url, content, name FROM documents WHERE id = ${docId}`;
            
            if (rows.length > 0) {
                const target = rows[0];
                const targetUrl = target.url || target.content;
                
                if (targetUrl) {
                    await inngest.send({ 
                        name: "app/delete.file", 
                        data: { docId: target.id, url: targetUrl } 
                    });
                }
            }

            // STEP 2: Always delete from Database
            await sql`DELETE FROM documents WHERE id = ${docId}`;
            return res.status(200).json({ success: true });
        } catch (e: any) {
            console.error("Delete handler error:", e);
            return res.status(500).json({ error: `Delete failed: ${e.message}` });
        }
    }
    return res.status(405).end();
}

async function handleFolders(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    const { action } = body;
    
    // Optimized: Only create table on CREATE action error, or list error.
    
    if (action === 'list') {
        try {
            const folders = await sql`SELECT * FROM app_folders ORDER BY name ASC`;
            return res.status(200).json({ folders: folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) })) });
        } catch (e: any) {
            // Fallback for list
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            return res.status(200).json({ folders: [] });
        }
    }
    if (action === 'create') {
        const { id, name, parentId } = body;
        try {
            await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${id}, ${name}, ${parentId || null}, ${Date.now()})`;
        } catch (e) {
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${id}, ${name}, ${parentId || null}, ${Date.now()})`;
        }
        return res.status(200).json({ success: true });
    }
    if (action === 'update') {
        const { id, name } = body;
        await sql`UPDATE app_folders SET name = ${name} WHERE id = ${id}`;
        return res.status(200).json({ success: true });
    }
    if (action === 'delete') {
        const { id } = body;
        await sql`DELETE FROM app_folders WHERE id = ${id}`;
        return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Invalid Action" });
}

async function handleProxy(req: VercelRequest, res: VercelResponse) {
    let { url, contentType: forcedType } = req.query; 
    if (Array.isArray(url)) url = url[0]; 
    
    if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });
    
    const ALLOWED = ['cloudinary.com', 'supabase.co', 'res.cloudinary.com'];
    try {
        const parsed = new URL(url);
        if (!ALLOWED.some(d => parsed.hostname.endsWith(d))) return res.status(403).json({ error: "Domain not allowed" });
        
        const targetUrl = parsed.toString();

        const upstream = await (fetch as any)(targetUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!upstream.ok) {
            const errText = await upstream.text().catch(() => 'Unknown upstream error');
            return res.status(upstream.status).json({ error: `Upstream error (${upstream.status}): ${errText.substring(0, 200)}` });
        }

        const buffer = Buffer.from(await upstream.arrayBuffer());
        const finalType = (forcedType as string) || upstream.headers.get('content-type') || 'application/octet-stream';
        res.setHeader('Content-Type', finalType);
        res.setHeader('Content-Disposition', 'inline'); 
        res.status(200).send(buffer);
    } catch (e: any) { res.status(500).json({ error: e.message }); }
}

async function handleUploadSupabase(req: VercelRequest, res: VercelResponse) {
    try {
        const supabaseUrl = getSupabaseEnv('SUPABASE_URL', true) || process.env.SUPABASE_URL?.trim();
        const supabaseKey = getSupabaseEnv('SUPABASE_SERVICE_ROLE_KEY') || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
        if (!supabaseUrl || !supabaseKey) return res.status(500).json({ error: 'Server thiếu cấu hình Supabase.' });
        const supabase = createClient(supabaseUrl, supabaseKey);
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
        const { filename } = body;
        if (!filename) return res.status(400).json({ error: "Missing filename" });
        const uniqueFileName = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9.]/g, '_')}`;
        const { data, error } = await supabase.storage.from('documents').createSignedUploadUrl(uniqueFileName);
        if (error) return res.status(500).json({ error: `Supabase Sign Error: ${error.message}` });
        const { data: publicData } = supabase.storage.from('documents').getPublicUrl(uniqueFileName);
        return res.status(200).json({ uploadUrl: data.signedUrl, publicUrl: publicData.publicUrl });
    } catch (err: any) { return res.status(500).json({ error: `Supabase Critical Error: ${err.message}` }); }
}

async function handleSync(req: VercelRequest, res: VercelResponse) {
    if (!process.env.PINECONE_API_KEY) {
        return res.status(500).json({ error: "Chưa cấu hình PINECONE_API_KEY." });
    }
    if (!process.env.PINECONE_INDEX_NAME) {
        return res.status(500).json({ error: "Chưa cấu hình PINECONE_INDEX_NAME." });
    }

    try {
        await inngest.send({ 
            name: "app/sync.database", 
            data: { timestamp: Date.now() } 
        });
        
        return res.status(200).json({ 
            success: true, 
            message: "Đã kích hoạt tiến trình đồng bộ ngầm." 
        });

    } catch (e: any) {
        return res.status(500).json({ error: `Không thể kích hoạt Sync Job: ${e.message}` });
    }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
    let { handler } = req.query;
    if (Array.isArray(handler)) handler = handler[0];
    const action = handler ? String(handler).toLowerCase() : null;

    if (action === 'proxy') return await handleProxy(req, res);
    
    try {
        if (!action) return res.status(200).json({ status: "API Ready" });
        if (action === 'users') return await handleUsers(req, res);
        if (action === 'files') return await handleFiles(req, res);
        if (action === 'folders') return await handleFolders(req, res);
        if (action === 'upload-supabase') return await handleUploadSupabase(req, res);
        if (action === 'sync') return await handleSync(req, res);
        
        if (action === 'sign-cloudinary') {
            try {
                let cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
                let apiKey = process.env.CLOUDINARY_API_KEY?.trim();
                let apiSecret = process.env.CLOUDINARY_API_SECRET?.trim();
                
                if (!cloudName || !apiKey || !apiSecret) {
                    return res.status(400).json({ error: "Cloudinary not configured", fallback: true });
                }
                
                const timestamp = Math.round(new Date().getTime() / 1000);
                const signature = cloudinary.utils.api_sign_request({ folder: 'ACESOfilter', timestamp }, apiSecret!);
                return res.status(200).json({ signature, apiKey, cloudName, timestamp, folder: 'ACESOfilter' });
            } catch (e: any) {
                return res.status(400).json({ error: "Cloudinary config error", fallback: true });
            }
        }
        if (action === 'trigger-ingest') {
             let body = req.body || {};
             if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
             const { url, fileName, fileType, docId } = body;
             if (!url || !docId) return res.status(400).json({ error: "Missing required fields" });
             
             // Lightweight fire-and-forget to Inngest
             await inngest.send({ name: "app/process.file", data: { url, fileName, fileType, docId } });
             return res.status(200).json({ success: true });
        }
        if (action === 'config') {
            const sql = await getSql();
            // Assuming table exists to save time. Fallback if not.
            try {
                if (req.method === 'POST') {
                    let body = req.body || {};
                    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
                    await sql`INSERT INTO system_settings (id, data) VALUES ('global', ${JSON.stringify(body)}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
                    return res.status(200).json({ success: true });
                } else {
                    const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`;
                    return res.status(200).json(rows.length > 0 ? JSON.parse(rows[0].data) : {}); 
                }
            } catch (e) {
                await sql`CREATE TABLE IF NOT EXISTS system_settings (id TEXT PRIMARY KEY, data TEXT)`;
                return res.status(200).json({});
            }
        }
        return res.status(404).json({ error: `Handler '${action}' not found` });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}