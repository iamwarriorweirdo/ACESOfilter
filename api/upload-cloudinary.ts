
import { v2 as cloudinary } from 'cloudinary';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Inngest } from 'inngest';
import { customAlphabet } from 'nanoid';
import { neon } from '@neondatabase/serverless';

const nanoid = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 10);

// Khởi tạo Inngest client
// Đảm bảo id khớp với id trong api/ingest.ts
export const inngest = new Inngest({ id: "hr-rag-app" });

export const config = { api: { bodyParser: false } };

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Kiểm tra biến môi trường Cloudinary
  if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: "Cloudinary credentials are not set." });
  }
  
  cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
  });

  const originalName = decodeURIComponent((req.headers['x-file-name'] as string) || 'file');
  const fileType = (req.headers['x-file-type'] as string) || 'application/octet-stream';
  const docId = nanoid(); // Tạo một ID duy nhất cho tài liệu

  return new Promise(async (resolve) => {
    try {
        // Lưu thông tin file vào database trước
        const dbUrl = process.env.DATABASE_URL || '';
        if (!dbUrl) throw new Error("DATABASE_URL is not set.");
        const sql = neon(dbUrl.replace('postgresql://', 'postgres://'));
        
        await sql`
            INSERT INTO documents (id, name, type, url, status, extracted_content, created_at, updated_at)
            VALUES (${docId}, ${originalName}, ${fileType}, '', 'pending', 'Đang chờ xử lý...', NOW(), NOW())
        `;

        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: 'ACESOfilter',
            resource_type: 'auto',
            type: 'upload',        
            access_mode: 'public', 
            public_id: originalName.replace(/\.[^/.]+$/, ""), // Sử dụng tên gốc không có đuôi làm public_id
            use_filename: true,
            unique_filename: false, // Để dễ quản lý, có thể chỉnh lại thành true nếu cần unique tuyệt đối
            overwrite: true
          },
          async (error, result) => {
            if (error) {
              console.error("Cloudinary Upload Error:", error);
              await sql`UPDATE documents SET status = 'failed', extracted_content = ${`Upload failed: ${error.message}`} WHERE id = ${docId}`;
              res.status(500).json({ error: error.message });
            } else if (result) {
              console.log("Cloudinary Upload Success:", result.secure_url);
              // Cập nhật URL và trạng thái trong DB
              await sql`UPDATE documents SET url = ${result.secure_url}, status = 'uploaded' WHERE id = ${docId}`;

              // Gửi sự kiện Inngest để xử lý file ở background
              await inngest.send({
                name: "app/process.file",
                data: {
                  url: result.secure_url,
                  fileName: originalName,
                  fileType: fileType,
                  docId: docId,
                },
              });

              res.status(200).json({ url: result.secure_url, size: result.bytes, docId: docId });
            }
            resolve(true);
          }
        );
        req.pipe(uploadStream);
    } catch (error: any) {
        console.error("Upload Handler Error:", error);
        // Nếu có lỗi trước khi stream, cập nhật trạng thái lỗi vào DB
        try {
            await sql`UPDATE documents SET status = 'failed', extracted_content = ${`Initial error: ${error.message}`} WHERE id = ${docId}`;
        } catch (dbErr) { console.error("Failed to update DB on error:", dbErr); }
        res.status(500).json({ error: error.message || "Internal server error" });
        resolve(true);
    }
  });
}
