export type ThreadDisplayStatus =
  | "approval"
  | "input"
  | "working"
  | "monitoring"
  | "supervising"
  | "failed"
  | "ready";

export type ThreadDisplayStatusInput = {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly session?: { readonly status: string } | null | undefined;
  readonly latestTurn?: { readonly state: string } | null | undefined;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly hasActiveDescendants?: boolean | undefined;
  readonly settled?: boolean | undefined;
};

/** Shared row status priority for web, desktop and mobile thread lists. */
export function resolveThreadDisplayStatus(input: ThreadDisplayStatusInput): ThreadDisplayStatus {
  if (input.hasPendingApprovals) return "approval";
  if (input.hasPendingUserInput) return "input";
  if (input.session?.status === "running" || input.session?.status === "starting") {
    return "working";
  }
  if (input.session?.status === "error") return "failed";
  // A stopped session is authoritative over a stale running turn. Shell-only
  // nested rows use the turn fallback only when no session exists.
  if (input.session == null && input.latestTurn?.state === "running") return "working";
  if (input.backgroundLiveness === "working") return "working";
  if (input.backgroundLiveness === "monitoring") return "monitoring";
  if (input.settled !== true && input.hasActiveDescendants === true) return "supervising";
  return "ready";
}

type DescendantActivityThread = ThreadDisplayStatusInput & {
  readonly id: string;
  readonly environmentId: string;
  readonly parentThreadId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly settledOverride?: string | null | undefined;
};

export function threadActivityKey(thread: Pick<DescendantActivityThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

function hasOwnActiveStatus(thread: DescendantActivityThread): boolean {
  if (thread.archivedAt != null || thread.settledOverride === "settled") return false;
  const status = resolveThreadDisplayStatus({
    ...thread,
    hasActiveDescendants: false,
    settled: false,
  });
  return (
    status === "approval" || status === "input" || status === "working" || status === "monitoring"
  );
}

/** Counts active descendants at every depth without trusting a cycle-free tree. */
export function countActiveDescendantsByThread(
  threads: ReadonlyArray<DescendantActivityThread>,
): ReadonlyMap<string, number> {
  const childrenByParent = new Map<string, DescendantActivityThread[]>();
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.parentThreadId == null) continue;
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    const children = childrenByParent.get(parentKey);
    if (children) children.push(thread);
    else childrenByParent.set(parentKey, [thread]);
  }

  const counts = new Map<string, number>();
  const count = (parentKey: string, visiting: Set<string>): number => {
    const cached = counts.get(parentKey);
    if (cached !== undefined) return cached;
    if (visiting.has(parentKey)) return 0;
    visiting.add(parentKey);
    const activeCount =
      childrenByParent.get(parentKey)?.reduce((total, child) => {
        const childKey = threadActivityKey(child);
        return total + Number(hasOwnActiveStatus(child)) + count(childKey, visiting);
      }, 0) ?? 0;
    visiting.delete(parentKey);
    counts.set(parentKey, activeCount);
    return activeCount;
  };

  for (const thread of threads) count(threadActivityKey(thread), new Set());
  return counts;
}
