import type { EnvironmentThreadShell } from "./models.ts";
import type { ForkThreadMetadata } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";
import {
  planPinnedMove,
  sortPinnedThreadsByOrderKey,
  sortActiveThreadsByOrderKey,
} from "./threadSort.ts";

type Metadata = ForkThreadMetadata & { readonly environmentId: string };
const key = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
export const supervisionOrderReady = (
  thread: EnvironmentThreadShell,
  readyHosts: ReadonlySet<string>,
) => readyHosts.has(thread.environmentId);
/** Orders only direct siblings on the child's host, even when their parent is disconnected. */
export function supervisionOrderSiblings(
  threads: readonly EnvironmentThreadShell[],
  metadata: readonly Metadata[],
  source: EnvironmentThreadShell,
  readyHosts: ReadonlySet<string>,
) {
  if (!supervisionOrderReady(source, readyHosts)) return [];
  const rows = new Map(metadata.map((row) => [`${row.environmentId}:${row.threadId}`, row]));
  const parent = (thread: EnvironmentThreadShell) => {
    const row = rows.get(`${thread.environmentId}:${thread.id}`);
    return JSON.stringify([
      row?.parentThreadId ?? null,
      row?.remoteParent?.environmentId ?? null,
      row?.remoteParent?.threadId ?? null,
    ]);
  };
  const siblings = threads.filter(
    (thread) =>
      thread.environmentId === source.environmentId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      parent(thread) === parent(source) &&
      (thread.pinnedAt !== null) === (source.pinnedAt !== null) &&
      (thread.pinnedAt !== null || thread.settledOverride !== "settled"),
  );
  return source.pinnedAt !== null
    ? sortPinnedThreadsByOrderKey(siblings)
    : sortActiveThreadsByOrderKey(siblings);
}
export function planSupervisionMove(
  threads: readonly EnvironmentThreadShell[],
  metadata: readonly Metadata[],
  source: EnvironmentThreadShell,
  direction: "up" | "down",
  readyHosts: ReadonlySet<string>,
) {
  const siblings = supervisionOrderSiblings(threads, metadata, source, readyHosts);
  return planPinnedMove({
    orderedIds: siblings.map(key),
    keysById: new Map(
      siblings.map((thread) => [
        key(thread),
        source.pinnedAt !== null ? thread.pinOrderKey : thread.activeOrderKey,
      ]),
    ),
    movedId: key(source),
    direction,
  });
}

/** Batch menu availability keeps large mobile rosters linear. */
export function supervisionMoveAvailability(
  ordered: readonly EnvironmentThreadShell[],
  metadata: readonly Metadata[],
  readyHosts: ReadonlySet<string>,
) {
  const rows = new Map(metadata.map((row) => [`${row.environmentId}:${row.threadId}`, row]));
  const buckets = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of ordered) {
    if (!supervisionOrderReady(thread, readyHosts)) continue;
    const row = rows.get(`${thread.environmentId}:${thread.id}`);
    const bucket = JSON.stringify([
      thread.environmentId,
      thread.pinnedAt !== null,
      row?.parentThreadId ?? null,
      row?.remoteParent?.environmentId ?? null,
      row?.remoteParent?.threadId ?? null,
    ]);
    const siblings = buckets.get(bucket) ?? [];
    siblings.push(thread);
    buckets.set(bucket, siblings);
  }
  const result = new Map<string, { canMoveUp: boolean; canMoveDown: boolean }>();
  for (const siblings of buckets.values())
    for (let i = 0; i < siblings.length; i++)
      result.set(key(siblings[i]!), { canMoveUp: i > 0, canMoveDown: i < siblings.length - 1 });
  return result;
}
