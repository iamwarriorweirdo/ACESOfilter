
// This file is deprecated. Logic resides in api/inngest.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
export default function handler(req: VercelRequest, res: VercelResponse) {
    res.status(410).json({ error: "Endpoint deprecated. Use api/inngest.ts" });
}
