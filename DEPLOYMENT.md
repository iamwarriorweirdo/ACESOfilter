# Kiến trúc & Hướng dẫn Deploy – ACESOfilter

## Tổng quan kiến trúc

| Thành phần | Công nghệ | Ghi chú |
|------------|-----------|---------|
| **Frontend** | React + Vite | Deploy trên Vercel (static/build) |
| **Backend API** | Vercel Serverless (thư mục `api/`) | Giới hạn Hobby: **10s timeout**, body **&lt; 5MB** |
| **Database** | Neon (PostgreSQL) | User, documents metadata, `extracted_content` (OCR/JSON) |
| **RAG / Vector** | Pinecone | Embedding từ Gemini, tìm kiếm ngữ nghĩa |
| **Lưu file** | Cloudinary (&lt;10MB), Supabase (&gt;10MB) | Upload từ FE trực tiếp lên Cloudinary/Supabase, **không qua Vercel** |
| **Background jobs** | Inngest | OCR, embed, cập nhật Neon + Pinecone |

## Luồng hiện tại

1. **Upload file**  
   FE upload trực tiếp lên Cloudinary hoặc Supabase → gọi `/api/app?handler=files` (lưu metadata) và `/api/ingest` (đẩy job vào Inngest). **Không có file &gt;5MB qua Vercel**, nên giới hạn 5MB của Vercel không ảnh hưởng upload.

2. **Ingest (OCR + RAG)**  
   `/api/ingest` chỉ gửi event vào Inngest và trả về ngay. Công việc nặng (tải file từ URL, OCR Gemini, lưu Neon, embed Pinecone) chạy trong **Inngest** (timeout dài hơn, không bị 10s).  
   **Điều kiện:** Inngest Cloud phải gọi được endpoint **`/api/inngest`** của app. Đã thêm file `api/inngest.ts` (serve handler) để đáp ứng điều này.

   **Cấu hình OCR / Index hiện tại:**
   - **Luồng:** Upload → metadata lưu Neon với `extracted_content = "Đang xử lý ngầm (AI OCR)..."` → `/api/ingest` gửi event `app/process.file` (url, fileName, fileType, docId) → Inngest chạy `process-file-background`: tải file từ URL → OCR (pdf-parse / mammoth / Gemini Vision) → cấu trúc metadata (Gemini JSON) → `UPDATE documents SET extracted_content = ... WHERE id = docId` → embed & upsert Pinecone.
   - **Vì sao vẫn "xoay" không hiện metadata:** (1) Inngest chưa chạy: kiểm tra Vercel env `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY` và đăng ký app URL `https://<domain>/api/inngest` trên Inngest Cloud. (2) Job Inngest lỗi hoặc timeout (file rất lớn): xem Inngest Dashboard → Runs. (3) Dialog nhận document “live” từ danh sách; khi Inngest cập nhật Neon, cần refresh danh sách (fetchDocs) hoặc mở lại file để thấy `extracted_content` mới. Tab "JSON Index (AI)" tự poll mỗi 3s khi nội dung chứa "Đang xử lý ngầm".
   - **RAG / Vercel Hobby:** Tìm kiếm dùng Neon (ILIKE) + Pinecone (vector). File chưa index xong (extracted_content vẫn "Đang xử lý...") sẽ không có trong RAG; Chat có bước fallback tìm theo **tên file** (ILIKE từ khóa) để vẫn trả lời được khi file đã có metadata nhưng vector chưa kịp index.

3. **Chat**  
   `/api/chat`: mở rộng query (Gemini) → tìm Neon + Pinecone → sinh câu trả lời (stream). Toàn bộ chuỗi này chạy trong **một request Vercel** → dễ vượt **10s** (đặc biệt khi RAG lớn hoặc câu trả lời dài).

## Vấn đề chính và hướng xử lý

### 1. Inngest không chạy trong production (đã xử lý)

- **Nguyên nhân:** Thiếu endpoint cho Inngest Cloud gọi lại (serve handler).
- **Đã làm:** Thêm `api/inngest.ts` dùng `serve()` từ `inngest/vercel`, export GET/POST/PUT.
- **Bạn cần:**
  - Đăng ký app tại [Inngest Cloud](https://app.inngest.com), thêm app với URL: `https://acesofilter.vercel.app/api/inngest`.
  - Trong Vercel → Project → Settings → Environment Variables thêm:
    - `INNGEST_EVENT_KEY` (để app gửi event lên Inngest).
    - `INNGEST_SIGNING_KEY` (để Inngest xác thực khi gọi `/api/inngest`).
  - Redeploy. Sau đó upload file → kiểm tra Inngest dashboard xem function đã chạy chưa.

### 2. Chat bị timeout 10s trên Vercel Hobby

- **Nguyên nhân:** Tổng thời gian (query expansion + DB + Pinecone + bắt đầu stream) &gt; 10s thì Vercel cắt request.
- **Hướng xử lý (chọn một hoặc kết hợp):**

| Cách | Mô tả | Độ phức tạp |
|------|--------|------------------|
| **A. Giữ Vercel, tối ưu** | Giảm query expansion (hoặc bỏ), giảm `topK` Pinecone, dùng model nhanh hơn cho bước mở rộng query. | Thấp |
| **B. Chỉ Chat sang Render/Railway** | FE vẫn trên Vercel; chỉ route `/api/chat` (hoặc proxy tới backend khác) chạy trên Render/Railway (timeout 30s+). Cần đổi URL chat ở FE sang backend mới. | Trung bình |
| **C. Chat qua Inngest (async)** | POST `/api/chat` tạo job Inngest, trả về `jobId` ngay; FE poll hoặc SSE để lấy kết quả. Job chạy trong Inngest (timeout dài). | Cao |

**Gợi ý:** Thử **A** trước (tối ưu). Nếu vẫn lỗi timeout thường xuyên thì cân nhắc **B** (chỉ đưa chat sang Render/Railway, không cần chuyển toàn bộ BE).

### 3. Có cần chuyển BE sang Hugging Face / Render?

- **Hugging Face Spaces:** Chủ yếu cho demo ML/FE, không phải backend API kiểu Vercel. Không cần dùng cho BE của app này.
- **Render (hoặc Railway):** Chỉ cần nếu bạn muốn **route chat** (hoặc vài route nặng) chạy với timeout &gt; 10s. Có thể:
  - Giữ toàn bộ API trên Vercel, chỉ chat qua Render; hoặc
  - Chạy một backend Node (Express/Fastify) trên Render, FE gọi `https://your-app.onrender.com/api/chat` cho chat, còn lại vẫn dùng Vercel.

**Kết luận:** Không bắt buộc chuyển toàn bộ BE. Ưu tiên: bật đúng Inngest (đã có endpoint) → tối ưu chat → nếu vẫn không đủ thì mới tách riêng chat sang Render.

### 4. Inngest cho ingest – đủ dùng chưa?

- **Đủ.** Ingest đã queue qua Inngest, job tải file từ Cloudinary/Supabase (URL), OCR, lưu Neon, embed Pinecone. Chỉ cần đảm bảo:
  - `/api/inngest` hoạt động (đã thêm),
  - Inngest Cloud đã kết nối và env keys đã set,
  - File &gt;10MB đã nằm trên Supabase (FE upload trực tiếp), URL đó truy cập được từ server (public hoặc signed URL).

## Checklist deploy mượt

1. **Env Vercel:**  
   `DATABASE_URL`, `API_KEY` (Gemini), `PINECONE_*`, Cloudinary, Supabase, `ADMIN_USER`/`ADMIN_PASS`, `INNGEST_EVENT_KEY`, `INNGEST_SIGNING_KEY`.

2. **Inngest:**  
   App URL = `https://acesofilter.vercel.app/api/inngest`, keys trong Vercel env.

3. **Tối ưu chat (tùy chọn):**  
   Trong `api/chat.ts`: giảm độ phức tạp query expansion, giảm `topK` (ví dụ 3→2), hoặc rút gọn prompt expansion để giảm thời gian trước khi stream.

4. **Nếu vẫn timeout chat:**  
   Cân nhắc đưa riêng endpoint chat sang Render/Railway và trỏ FE tới URL đó cho chat.

---

**Tóm tắt:** App đã sẵn sàng chạy online với Inngest (ingest nền). Vấn đề còn lại chủ yếu là **timeout 10s của chat** trên Vercel; xử lý bằng tối ưu hoặc tách chat sang backend có timeout dài hơn (Render/Railway) nếu cần.
