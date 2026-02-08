
import { handleUpload } from '@vercel/blob/client';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req as any,
      onBeforeGenerateToken: async (pathname) => {
        return {
          allowedContentTypes: [
              'application/pdf', 
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'image/jpeg', 
              'image/png',
              'text/plain'
          ],
          tokenPayload: JSON.stringify({ uploadTime: Date.now() }),
        };
      },
      onUploadCompleted: async ({ blob }) => {
        console.log('Blob upload completed:', blob.url);
      },
    });

    return res.status(200).json(jsonResponse);
  } catch (error: any) {
    return res.status(400).json({ error: error.message });
  }
}
