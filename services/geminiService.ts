
import { Message, SystemConfig } from "../types";

export const generateResponse = async (
  history: Message[],
  config: SystemConfig | any, // Nhận config từ App để biết user chọn model nào
  onStream: (text: string) => void
) => {
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
          messages: history,
          config: config // Gửi config xuống backend
      }),
    });

    if (!response.ok) {
        // Cố gắng đọc nội dung lỗi từ server
        let errorMsg = `Server Error: ${response.status} ${response.statusText}`;
        try {
            const errorText = await response.text();
            // Thử parse JSON nếu có
            try {
                const json = JSON.parse(errorText);
                if (json.error) errorMsg = json.error;
            } catch {
                // Nếu không phải JSON, lấy text raw (cắt ngắn nếu quá dài)
                if (errorText) errorMsg = `Server Error (${response.status}): ${errorText.slice(0, 200)}`;
            }
        } catch (e) {
            // Lỗi khi đọc body
        }
        throw new Error(errorMsg);
    }

    const reader = response.body?.getReader();
    const decoder = new TextDecoder();

    if (!reader) throw new Error("No response body");

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      onStream(chunk);
    }

  } catch (error: any) {
    console.error("API Error:", error);
    onStream(`\n\n[System Error]: ${error.message}\n(Please check Vercel Logs for details)`);
  }
};
