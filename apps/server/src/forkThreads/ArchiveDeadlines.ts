import { isPermanentRoot } from "./PermanentRoots.ts";
import type { ForkThreadMetadata, ThreadId, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

type Thread = OrchestrationV2ThreadShell;
const epoch = (date: DateTime.Utc) => DateTime.toEpochMillis(date);
export const archiveDeadline = (thread: Thread, days: number) =>
  thread.settledAt == null
    ? null
    : Math.max(epoch(thread.settledAt), epoch(thread.updatedAt)) + days * 86_400_000;

export function hasActiveWork(thread: Thread): boolean {
  return (
    thread.codexNativeGoal?.status === "active" ||
    thread.pendingRuntimeRequest != null ||
    thread.hasActionableProposedPlan ||
    ["running", "queued", "waiting", "starting"].includes(thread.status) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  );
}

/** Re-evaluated under the orchestrator command lock, including every descendant. */
export function archiveEligible(
  thread: Thread,
  threads: ReadonlyArray<Thread> | ReadonlyMap<ThreadId | null, ReadonlyArray<Thread>>,
  before: number,
  metadata?: ForkThreadMetadata,
  organization: ReadonlyMap<ThreadId, ForkThreadMetadata> = new Map(),
  permanentRoots: ReadonlySet<ThreadId> = new Set(),
): boolean {
  if (
    !(metadata?.parentThreadId != null || metadata?.remoteParent != null) ||
    thread.archivedAt ||
    thread.settledOverride !== "settled" ||
    thread.settledAt == null ||
    thread.pinnedAt ||
    isPermanentRoot(thread.id, permanentRoots) ||
    thread.autoSettleDisabledAt ||
    metadata?.settleOnComplete === false ||
    hasActiveWork(thread) ||
    Math.max(epoch(thread.settledAt), epoch(thread.updatedAt)) > before
  )
    return false;
  const children =
    "get" in threads
      ? threads
      : Map.groupBy(threads, (child) => organization.get(child.id)?.parentThreadId ?? null);
  const pending = [...(children.get(thread.id) ?? [])];
  const visited = new Set([thread.id]);
  while (pending.length) {
    const child = pending.pop()!;
    if (visited.has(child.id)) return false;
    visited.add(child.id);
    if (
      hasActiveWork(child) ||
      (!child.archivedAt && child.settledOverride !== "settled") ||
      child.pinnedAt ||
      isPermanentRoot(child.id, permanentRoots) ||
      child.autoSettleDisabledAt
    )
      return false;
    pending.push(...(children.get(child.id) ?? []));
  }
  return true;
}
