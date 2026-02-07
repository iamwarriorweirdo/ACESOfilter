
import * as neonServerless from '@neondatabase/serverless';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const { neon } = neonServerless;
const rawConnectionString = process.env.DATABASE_URL || '';
const connectionString = rawConnectionString.replace('postgresql://', 'postgres://');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Chỉ cho phép Admin gọi (Thực tế nên check thêm Session Token/Cookie)
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    if (!connectionString) return res.status(500).json({ error: "DB Disconnected" });
    const sql = neon(connectionString);

    // 1. Lấy dữ liệu từ tất cả các bảng quan trọng
    // Sử dụng Promise.all để chạy song song cho nhanh
    const [users, documents, folders, sessions, settings] = await Promise.all([
        sql`SELECT * FROM users`,
        sql`SELECT * FROM documents`,
        sql`SELECT * FROM app_folders`,
        sql`SELECT * FROM app_chat_sessions`,
        sql`SELECT * FROM settings`
    ]);

    // 2. Cấu trúc dữ liệu Backup
    const backupData = {
        metadata: {
            timestamp: Date.now(),
            version: '1.0',
            exported_by: 'System Admin'
        },
        data: {
            users: users,
            documents: documents,
            folders: folders,
            chat_sessions: sessions,
            settings: settings
        }
    };

    // 3. Trả về file JSON để trình duyệt tải xuống
    const filename = `backup-system-${new Date().toISOString().split('T')[0]}.json`;

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    return res.status(200).send(JSON.stringify(backupData, null, 2));

  } catch (error: any) {
    console.error("Backup Error:", error);
    return res.status(500).json({ error: error.message });
  }
}
