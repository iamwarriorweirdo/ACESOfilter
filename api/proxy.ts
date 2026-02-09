
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';

const ALLOWED_DOMAINS = [
    'cloudinary.com',
    'supabase.co',
    'res.cloudinary.com'
];

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });

  // BẢO MẬT: Chặn SSRF bằng cách chỉ cho phép các domain trong danh sách trắng
  try {
      const parsedUrl = new URL(url);
      const isAllowed = ALLOWED_DOMAINS.some(domain => parsedUrl.hostname.endsWith(domain));
      if (!isAllowed) {
          return res.status(403).json({ error: "Domain not allowed via proxy for security reasons." });
      }
  } catch (e) {
      return res.status(400).json({ error: "Invalid URL format." });
  }

  try {
    const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    
    if (!response.ok) return res.status(response.status).json({ error: `Remote error ${response.status}` });

    const buffer = Buffer.from(await response.arrayBuffer());
    let contentType = response.headers.get('content-type') || 'application/octet-stream';
    if (url.toLowerCase().endsWith('.pdf')) contentType = 'application/pdf';

    res.setHeader('Content-Type', contentType);
    res.write(buffer);
    res.end();
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}
