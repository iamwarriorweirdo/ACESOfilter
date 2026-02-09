
import { serve } from "inngest/node";
import { Inngest } from "inngest";
export const inngest = new Inngest({ id: "hr-rag-app" });

// Endpoint này chỉ dùng để chuyển tiếp job, logic chính nằm ở api/inngest.ts
const processFileProxy = inngest.createFunction(
  { id: "process-file-proxy", retries: 0 },
  { event: "app/process.file" },
  async ({ event, step }) => {
     // Forward to main processor if needed, but in this architecture 
     // the same inngest client handles the functions.
  }
);

export default serve({ client: inngest, functions: [processFileProxy] });
