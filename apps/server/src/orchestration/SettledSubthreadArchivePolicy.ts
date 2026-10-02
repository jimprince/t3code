import type { OrchestrationThreadShell } from "@t3tools/contracts";

type ArchiveThread = Pick<
  OrchestrationThreadShell,
  | "id"
  | "parentThreadId"
  | "archivedAt"
  | "settledOverride"
  | "updatedAt"
  | "settledAt"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "session"
  | "latestTurn"
  | "backgroundLiveness"
>;

function hasActiveWork(thread: ArchiveThread): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.backgroundLiveness != null
  );
}

/** Rechecked by the decider so resumed descendants cannot lose their parent to a stale timer. */
export function isSettledSubthreadArchiveCandidate(
  thread: ArchiveThread,
  threads: ReadonlyArray<ArchiveThread>,
  settledBefore: string,
): boolean {
  if (
    thread.parentThreadId == null ||
    thread.archivedAt !== null ||
    thread.settledOverride !== "settled" ||
    thread.settledAt === null ||
    Math.max(Date.parse(thread.settledAt), Date.parse(thread.updatedAt)) >
      Date.parse(settledBefore) ||
    thread.pinnedAt != null ||
    thread.autoSettleDisabledAt != null ||
    hasActiveWork(thread)
  )
    return false;
  const children = Map.groupBy(threads, (entry) => entry.parentThreadId ?? null);
  const pending = [...(children.get(thread.id) ?? [])];
  const visited = new Set([thread.id]);
  while (pending.length > 0) {
    const descendant = pending.pop()!;
    if (visited.has(descendant.id)) return false;
    visited.add(descendant.id);
    if (
      hasActiveWork(descendant) ||
      (descendant.archivedAt === null && descendant.settledOverride !== "settled")
    )
      return false;
    pending.push(...(children.get(descendant.id) ?? []));
  }
  return true;
}
