import type { ThreadId } from "@t3tools/contracts";

/** M3 named-agent policy supplies permanent roots; M2 has none. */
export const isPermanentRoot = (_threadId: ThreadId): boolean => false;
