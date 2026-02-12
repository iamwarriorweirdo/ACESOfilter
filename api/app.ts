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

function getCloudinaryConfig() {
    // Ưu tiên biến môi trường riêng lẻ
    if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
        return {
            cloudName: process.env.CLOUDINARY_CLOUD_NAME,
            apiKey: process.env.CLOUDINARY_API_KEY,
            apiSecret: process.env.CLOUDINARY_API_SECRET
        };
    }
    // Fallback: Parse từ CLOUDINARY_URL
    const url = process.env.CLOUDINARY_URL;
    if (url && url.startsWith('cloudinary://')) {
        try {
            const [creds, cloud] = url.replace('cloudinary://', '').split('@');
            const [key, secret] = creds.split(':');
            return { cloudName: cloud, apiKey: key, apiSecret: secret };
        } catch (e) { 
            console.error("Error parsing CLOUDINARY_URL", e);
            return {}; 
        }
    }
    return {};
}

// --- HANDLERS ---

async function handleBackup(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    try {
        const users = await sql`SELECT * FROM users`.catch(() => []);
        const documents = await sql`SELECT * FROM documents`.catch(() => []);
        const folders = await sql`SELECT * FROM app_folders`.catch(() => []);
        const settings = await sql`SELECT * FROM system_settings`.catch(() => []);

        const backupData = {
            timestamp: Date.now(),
            users,
            documents,
            folders,
            settings,
            version: "1.0",
            exportedAt: new Date().toISOString()
        };

        const filename = `full_system_backup_${new Date().toISOString().split('T')[0]}.json`;
        
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.status(200).send(JSON.stringify(backupData, null, 2));
    } catch (e: any) {
        return res.status(500).json({ error: `Backup failed: ${e.message}` });
    }
}

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

        if (sysAdminUser && inputUser.toLowerCase() === sysAdminUser.toLowerCase()) {
            if (inputPass === sysAdminPass) {
                return res.status(200).json({ success: true, user: { username: sysAdminUser, role: 'superadmin' } });
            }
        }
        
        const sql = await getSql();
        try {
            const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
            if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
        } catch (e) {
            await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
            const results = await sql`SELECT * FROM users WHERE username = ${username} AND password = ${password}`;
            if (results.length > 0) return res.status(200).json({ success: true, user: results[0] });
        }
        return res.status(401).json({ error: "Sai tài khoản hoặc mật khẩu." });
    }
    
    if (action === 'create') {
        const sql = await getSql();
        await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
        const roleVal = (role === 'superadmin' || role === 'it' || role === 'hr' || role === 'employee') ? role : 'employee';
        await sql`INSERT INTO users (username, password, role, created_at, created_by) VALUES (${username}, ${password}, ${roleVal}, ${Date.now()}, ${createdBy || 'system'}) ON CONFLICT (username) DO UPDATE SET password = EXCLUDED.password, role = EXCLUDED.role`;
        return res.status(200).json({ success: true });
    }

    if (action === 'list') {
        const sql = await getSql();
        await sql`CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password TEXT, role TEXT, created_at BIGINT, created_by TEXT)`;
        const rows = await sql`SELECT username, role, created_at, created_by FROM users ORDER BY username`;
        return res.status(200).json({ users: rows });
    }
    return res.status(400).json({ error: "Invalid action" });
}

async function handleFiles(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    const method = req.method?.toUpperCase();
    
    if (method === 'GET') {
        const { id } = req.query;
        if (id) {
            const rows = await sql`SELECT id, name, extracted_content FROM documents WHERE id = ${id}`;
            if (rows.length === 0) return res.status(404).json({ error: "File not found" });
            return res.status(200).json(rows[0]);
        }
        const docs = await sql`SELECT id, name, type, content, url, size, upload_date, folder_id, uploaded_by, status FROM documents ORDER BY upload_date DESC`.catch(() => []);
        const mappedDocs = docs.map((d: any) => ({
            id: d.id, name: d.name, type: d.type, content: d.content || d.url, url: d.url || d.content,
            size: Number(d.size), uploadDate: Number(d.upload_date), status: d.status || 'pending',
            folderId: d.folder_id || null, uploadedBy: d.uploaded_by || 'system'
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
            await sql`INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content, status) 
                      VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}, ${doc.status || 'pending'}) 
                      ON CONFLICT (id) DO UPDATE SET url = EXCLUDED.url, content = EXCLUDED.content, extracted_content = EXCLUDED.extracted_content, folder_id = EXCLUDED.folder_id, status = EXCLUDED.status`;
        } catch (e: any) {
            await sql`CREATE TABLE IF NOT EXISTS documents (id TEXT PRIMARY KEY, name TEXT, type TEXT, content TEXT, url TEXT, size BIGINT, upload_date BIGINT, extracted_content TEXT, folder_id TEXT, uploaded_by TEXT)`;
            try { await sql`ALTER TABLE documents ADD COLUMN IF NOT EXISTS status TEXT`; } catch (_) { }
            await sql`INSERT INTO documents (id, name, type, content, url, size, upload_date, uploaded_by, folder_id, extracted_content, status) 
                      VALUES (${doc.id}, ${doc.name}, ${doc.type}, ${doc.content}, ${doc.content}, ${doc.size}, ${doc.uploadDate}, ${doc.uploadedBy}, ${doc.folderId || null}, ${doc.extractedContent || ''}, ${doc.status || 'pending'}) 
                      ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status`;
        }
        return res.status(200).json({ success: true });
    }

    if (method === 'DELETE') {
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
        const docId = body.id;
        const rows = await sql`SELECT id, url, content FROM documents WHERE id = ${docId}`;
        
        if (rows.length > 0) {
            const row = rows[0];
            const fileUrl = row.url || row.content;

            // Trigger Pinecone cleanup
            await inngest.send({ name: "app/delete.file", data: { docId: row.id, url: fileUrl } });

            // --- DELETE ACTUAL FILE FROM STORAGE ---
            try {
                // 1. Delete from Cloudinary
                if (fileUrl && fileUrl.includes('cloudinary.com')) {
                    const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
                    if (cloudName && apiKey && apiSecret) {
                         cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
                         // Extract public_id: .../upload/(v1234/)?(folder/id).ext
                         const regex = /\/upload\/(?:v\d+\/)?(.+)\.[a-zA-Z0-9]+$/;
                         const match = fileUrl.match(regex);
                         if (match && match[1]) {
                             const publicId = match[1];
                             await cloudinary.uploader.destroy(publicId);
                             console.log(`Deleted Cloudinary asset: ${publicId}`);
                         }
                    } else {
                        console.warn("Skip Cloudinary delete: credentials missing");
                    }
                } 
                // 2. Delete from Supabase
                else if (fileUrl && fileUrl.includes('supabase.co')) {
                     // .../storage/v1/object/public/documents/path/to/file
                     const parts = fileUrl.split('/object/public/documents/');
                     if (parts.length > 1) {
                         const path = decodeURIComponent(parts[1]);
                         const sbUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
                         const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
                         if (sbUrl && sbKey) {
                             const supabase = createClient(sbUrl, sbKey);
                             const { error } = await supabase.storage.from('documents').remove([path]);
                             if (error) console.error("Supabase delete failed:", error);
                             else console.log(`Deleted Supabase asset: ${path}`);
                         }
                     }
                }
            } catch (storageError) {
                console.error("Storage deletion error:", storageError);
                // Continue to delete from DB even if storage delete fails
            }
        }

        await sql`DELETE FROM documents WHERE id = ${docId}`;
        return res.status(200).json({ success: true });
    }
    return res.status(405).end();
}

async function handleFolders(req: VercelRequest, res: VercelResponse) {
    const sql = await getSql();
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { } }
    const { action } = body;
    if (action === 'list') {
        const folders = await sql`SELECT * FROM app_folders ORDER BY name ASC`.catch(async () => {
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            return [];
        });
        return res.status(200).json({ folders: folders.map((f: any) => ({ id: f.id, name: f.name, parentId: f.parent_id, createdAt: Number(f.created_at) })) });
    }
    if (action === 'create') {
        await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${body.id}, ${body.name}, ${body.parentId || null}, ${Date.now()})`.catch(async () => {
            await sql`CREATE TABLE IF NOT EXISTS app_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL, parent_id TEXT, created_at BIGINT)`;
            await sql`INSERT INTO app_folders (id, name, parent_id, created_at) VALUES (${body.id}, ${body.name}, ${body.parentId || null}, ${Date.now()})`;
        });
        return res.status(200).json({ success: true });
    }
    return res.status(400).json({ error: "Action not supported" });
}

async function handleUploadSupabase(req: VercelRequest, res: VercelResponse) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
    
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

    if (!supabaseUrl || !supabaseKey) {
        return res.status(500).json({ error: "Supabase chưa được cấu hình (Missing URL/Key). Vui lòng thêm biến môi trường SUPABASE_URL và SUPABASE_KEY." });
    }

    try {
        const supabase = createClient(supabaseUrl, supabaseKey);
        let body = req.body || {};
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch(e){} }
        
        const filename = body.filename || `file_${Date.now()}`;
        const cleanName = filename.replace(/[^a-zA-Z0-9.\-_]/g, '_');
        const path = `${Date.now()}_${cleanName}`;

        const { data, error } = await supabase.storage
            .from('documents')
            .createSignedUploadUrl(path);

        if (error) {
             console.error("Supabase Storage Error:", error);
             return res.status(500).json({ error: `Supabase Error: ${error.message}` });
        }

        const { data: publicData } = supabase.storage
            .from('documents')
            .getPublicUrl(path);

        return res.status(200).json({
            uploadUrl: data?.signedUrl,
            publicUrl: publicData.publicUrl
        });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}

async function handleProxy(req: VercelRequest, res: VercelResponse) {
    let { url, contentType: forcedType } = req.query; 
    if (Array.isArray(url)) url = url[0]; 
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const upstream = await (fetch as any)(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader('Content-Type', (forcedType as string) || upstream.headers.get('content-type') || 'application/octet-stream');
    return res.status(200).send(buffer);
}

// --- EXPORT ---

export default async function handler(req: VercelRequest, res: VercelResponse) {
    const { handler: h } = req.query;
    const action = Array.isArray(h) ? h[0].toLowerCase() : String(h || "").toLowerCase();

    try {
        if (action === 'backup') return await handleBackup(req, res);
        if (action === 'proxy') return await handleProxy(req, res);
        if (action === 'users') return await handleUsers(req, res);
        if (action === 'files') return await handleFiles(req, res);
        if (action === 'folders') return await handleFolders(req, res);
        if (action === 'upload-supabase') return await handleUploadSupabase(req, res);
        if (action === 'sync') {
            await inngest.send({ name: "app/sync.database", data: { timestamp: Date.now() } });
            return res.status(200).json({ success: true });
        }
        if (action === 'config') {
            const sql = await getSql();
            if (req.method === 'POST') {
                await sql`INSERT INTO system_settings (id, data) VALUES ('global', ${JSON.stringify(req.body)}) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`;
                return res.status(200).json({ success: true });
            }
            const rows = await sql`SELECT data FROM system_settings WHERE id = 'global'`.catch(() => []);
            return res.status(200).json(rows.length > 0 ? JSON.parse(rows[0].data) : {});
        }
        
        // Cloudinary helper
        if (action === 'sign-cloudinary') {
            const { cloudName, apiKey, apiSecret } = getCloudinaryConfig();
            
            if (!cloudName || !apiKey || !apiSecret) {
                // Return explicit error so frontend can fallback to Supabase if needed
                return res.status(500).json({ error: "Cloudinary configuration missing", fallback: true });
            }

            cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret });
            const timestamp = Math.round(new Date().getTime() / 1000);
            const signature = cloudinary.utils.api_sign_request({ folder: 'ACESOfilter', timestamp }, apiSecret);
            return res.status(200).json({ signature, apiKey, cloudName, timestamp, folder: 'ACESOfilter' });
        }

        if (action === 'trigger-ingest') {
            await inngest.send({ name: "app/process.file", data: req.body });
            return res.status(200).json({ success: true });
        }

        if (!action) return res.status(200).json({ status: "API Online" });
        return res.status(404).json({ error: `Handler '${action}' not found` });
    } catch (e: any) {
        return res.status(500).json({ error: e.message });
    }
}