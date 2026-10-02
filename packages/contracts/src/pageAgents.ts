/**
 * Page agents are the conversations in an embedded page's side tray. Each one
 * is an ordinary thread in the server-owned chat project; what sets it apart is
 * this reserved id namespace. The server keeps these threads out of every
 * client-facing thread list (sidebar, mobile, command palette, notifications,
 * agent tooling) while they still run turns and stream their detail by id like
 * any other thread.
 */
const PAGE_AGENT_THREAD_ID_PREFIX = "page-agent-";

export function isPageAgentThreadId(threadId: string): boolean {
  return threadId.startsWith(PAGE_AGENT_THREAD_ID_PREFIX);
}

/** A fresh conversation id for one page. `nonce` is a client-generated UUID. */
export function makePageAgentThreadId(pageId: string, nonce: string): string {
  return `${PAGE_AGENT_THREAD_ID_PREFIX}${pageId}-${nonce}`;
}

/** Drops page-agent threads from a shell snapshot before it reaches a client. */
export function withoutPageAgentThreads<
  TSnapshot extends { readonly threads: ReadonlyArray<{ readonly id: string }> },
>(snapshot: TSnapshot): TSnapshot {
  return snapshot.threads.some((thread) => isPageAgentThreadId(thread.id))
    ? { ...snapshot, threads: snapshot.threads.filter((thread) => !isPageAgentThreadId(thread.id)) }
    : snapshot;
}
