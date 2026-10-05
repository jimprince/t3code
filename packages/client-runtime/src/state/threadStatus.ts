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
  readonly remoteParent?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly settledOverride?: string | null | undefined;
};

export function threadActivityKey(thread: Pick<DescendantActivityThread, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

/** Resolves local and remote parent links to the same scoped client key. */
export function threadParentKey(thread: {
  readonly environmentId: string;
  readonly parentThreadId?: string | null | undefined;
  readonly remoteParent?:
    | { readonly environmentId: string; readonly threadId: string }
    | null
    | undefined;
}): string | null {
  if (thread.remoteParent != null)
    return `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`;
  return thread.parentThreadId == null ? null : `${thread.environmentId}:${thread.parentThreadId}`;
}

/** Parent links only hide a child when its parent is reachable and the chain is acyclic. */
export function reachableNestedThreadKeys<
  T extends {
    readonly id: string;
    readonly environmentId: string;
    readonly archivedAt?: string | null | undefined;
    readonly parentThreadId?: string | null | undefined;
    readonly remoteParent?:
      | { readonly environmentId: string; readonly threadId: string }
      | null
      | undefined;
  },
>(threads: ReadonlyArray<T>): Set<string> {
  const byKey = new Map(threads.map((thread) => [threadActivityKey(thread), thread]));
  const nested = new Set<string>();
  for (const thread of threads) {
    const parentKey = threadParentKey(thread);
    const parent = parentKey === null ? undefined : byKey.get(parentKey);
    if (parent === undefined || parent.archivedAt != null) continue;
    const visited = new Set<string>();
    let ancestor: T | undefined = thread;
    while (ancestor !== undefined && !visited.has(threadActivityKey(ancestor))) {
      visited.add(threadActivityKey(ancestor));
      const key = threadParentKey(ancestor);
      ancestor = key === null ? undefined : byKey.get(key);
    }
    if (ancestor === undefined) nested.add(threadActivityKey(thread));
  }
  return nested;
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
    const parentKey = threadParentKey(thread);
    if (thread.archivedAt != null || parentKey === null) continue;
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
