import type { EnvironmentThreadShell } from "./models.ts";
import type { ForkThreadMetadata } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";
import { planPinnedMove, sortPinnedThreadsByOrderKey, sortActiveThreadsByOrderKey } from "./threadSort.ts";

type Metadata = ForkThreadMetadata & { readonly environmentId: string };
const key = (thread: EnvironmentThreadShell) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
/** Orders only direct siblings on the child's host, even when their parent is disconnected. */
export function supervisionOrderSiblings(threads: readonly EnvironmentThreadShell[], metadata: readonly Metadata[], source: EnvironmentThreadShell) {
  const rows = new Map(metadata.map(row => [`${row.environmentId}:${row.threadId}`, row]));
  const parent = (thread: EnvironmentThreadShell) => {
    const row = rows.get(`${thread.environmentId}:${thread.id}`);
    return row?.remoteParent ? `${row.remoteParent.environmentId}:${row.remoteParent.threadId}` : row?.parentThreadId ?? null;
  };
  const siblings = threads.filter(thread => thread.environmentId === source.environmentId && thread.archivedAt === null && thread.deletedAt === null && parent(thread) === parent(source) && (thread.pinnedAt !== null) === (source.pinnedAt !== null) && (thread.pinnedAt !== null || thread.settledOverride !== "settled"));
  return source.pinnedAt !== null ? sortPinnedThreadsByOrderKey(siblings) : sortActiveThreadsByOrderKey(siblings);
}
export function planSupervisionMove(threads: readonly EnvironmentThreadShell[], metadata: readonly Metadata[], source: EnvironmentThreadShell, direction: "up" | "down") {
  const siblings = supervisionOrderSiblings(threads, metadata, source);
  return planPinnedMove({ orderedIds: siblings.map(key), keysById: new Map(siblings.map(thread => [key(thread), source.pinnedAt !== null ? thread.pinOrderKey : thread.activeOrderKey])), movedId: key(source), direction });
}
