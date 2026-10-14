import type { ThreadResumeResult } from "@t3tools/contracts";
/** CLI output for preview is the exact seed returned by the production RPC. */
export async function runResumePlan(
  client: {
    resumePlan: (
      threadId: string,
      preview: boolean,
    ) => Promise<ThreadResumeResult | { seed: string }>;
  },
  threadId: string,
  preview: boolean,
  write: (text: string) => void,
) {
  const result = await client.resumePlan(threadId, preview);
  write("seed" in result ? `${result.seed}\n` : `${JSON.stringify(result, null, 2)}\n`);
}
