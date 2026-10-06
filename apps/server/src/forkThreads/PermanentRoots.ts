import type { ThreadId } from "@t3tools/contracts";

/** Snapshot membership supplied by the lifecycle sweep; no cross-runtime mutable registry. */
export const isPermanentRoot = (
  threadId: ThreadId,
  roots: ReadonlySet<ThreadId> = new Set(),
): boolean => roots.has(threadId);
