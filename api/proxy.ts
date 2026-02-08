
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Buffer } from 'node:buffer';
import { v2 as cloudinary } from 'cloudinary';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { url } = req.query;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'Missing url' });

  // Cloudinary Config (Use CLOUDINARY_URL if available for easier setup)
  if (process.env.CLOUDINARY_URL) {
      cloudinary.config({ secure: true }); 
  } else {
      cloudinary.config({
          cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
          api_key: process.env.CLOUDINARY_API_KEY,
          api_secret: process.env.CLOUDINARY_API_SECRET,
          secure: true
      });
  }

  const getPublicId = (fileUrl: string) => {
      if (!fileUrl.includes('cloudinary.com')) return null;
      const parts = fileUrl.split('/upload/');
      if (parts.length < 2) return null;
      let right = parts[1];
      const segments = right.split('/');
      if (segments[0].startsWith('v') && /^\d+$/.test(segments[0].substring(1))) segments.shift();
      const pathWithExt = segments.join('/');
      return { 
          fullPath: pathWithExt, 
          idWithoutExt: pathWithExt.replace(/\.[^/.]+$/, "") 
      };
  };

  const fetchWithStrategies = async (targetUrl: string): Promise<Response> => {
      const headers: Record<string, string> = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
      
      if (targetUrl.includes('supabase.co')) {
          return await fetch(targetUrl, { headers });
      }
      
      // Strategy 1: Original URL
      console.log(`[Proxy] Try 1 (Original): ${targetUrl}`);
      let resp = await fetch(targetUrl, { headers });
      if (resp.ok) return resp;

      // Strategy 2: Switch image <-> raw
      if (targetUrl.includes('cloudinary.com') && (resp.status === 401 || resp.status === 404)) {
          let altUrl = targetUrl;
          if (targetUrl.includes('/image/upload/')) altUrl = targetUrl.replace('/image/upload/', '/raw/upload/');
          else if (targetUrl.includes('/raw/upload/')) altUrl = targetUrl.replace('/raw/upload/', '/image/upload/');
          
          if (altUrl !== targetUrl) {
              console.log(`[Proxy] Try 2 (Swapped Type): ${altUrl}`);
              resp = await fetch(altUrl, { headers });
              if (resp.ok) return resp;
          }
      }

      // Strategy 3: Signed URL (Authenticated)
      const info = getPublicId(targetUrl);
      if (info && process.env.CLOUDINARY_API_SECRET) {
          console.log(`[Proxy] Try 3 (Signed Authenticated)...`);
          const signedUrl = cloudinary.url(info.fullPath, { 
              resource_type: targetUrl.includes('/raw/') ? 'raw' : 'image',
              sign_url: true,
              type: 'authenticated'
          });
          resp = await fetch(signedUrl, { headers });
          if (resp.ok) return resp;

          // Strategy 4: Signed URL (Upload type but signed)
          console.log(`[Proxy] Try 4 (Signed Upload)...`);
          const signedUrl2 = cloudinary.url(info.fullPath, { 
              resource_type: targetUrl.includes('/raw/') ? 'raw' : 'image',
              sign_url: true,
              type: 'upload'
          });
          resp = await fetch(signedUrl2, { headers });
          if (resp.ok) return resp;
      }

      return resp;
  };

  try {
    const response = await fetchWithStrategies(url);
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
