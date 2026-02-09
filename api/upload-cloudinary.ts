
// This file is deprecated. Frontend uses direct upload with signatures.
import type { VercelRequest, VercelResponse } from '@vercel/node';
export default function handler(req: VercelRequest, res: VercelResponse) {
    res.status(410).json({ error: "Endpoint deprecated." });
}
