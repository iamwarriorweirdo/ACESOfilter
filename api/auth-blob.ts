
// This file has been merged into api/app.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
export default function handler(req: VercelRequest, res: VercelResponse) {
    res.status(410).json({ error: "Endpoint deprecated. Use /api/app?handler=auth-blob" });
}
