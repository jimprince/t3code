import type { ForkThreadMetadata, ThreadId } from "@t3tools/contracts";

export interface SupervisionThread {
  readonly id: ThreadId;
  readonly projectId: string;
  readonly archivedAt: unknown | null;
}
/** Hidden, archived, absent and cyclic parents cannot make a visible child unreachable. */
export function supervisionParents<T extends SupervisionThread>(threads: readonly T[], metadata: readonly ForkThreadMetadata[]) {
  const visible = new Map(threads.filter(thread => thread.archivedAt === null).map(thread => [thread.id, thread]));
  const raw = new Map(metadata.map(row => [row.threadId, row.parentThreadId]));
  const parents = new Map<ThreadId, ThreadId | null>();
  for (const id of visible.keys()) {
    const immediate = raw.get(id) ?? null;
    parents.set(id, immediate);
    // The walk terminating at a root differs from termination at an invalid edge.
    if (immediate !== null) {
      let node: ThreadId | null = immediate;
      const visited = new Set<ThreadId>([id]);
      while (node !== null) {
        if (!visible.has(node) || visited.has(node)) { parents.set(id, null); break; }
        visited.add(node);
        node = raw.get(node) ?? null;
      }
    }
  }
  return parents;
}
export function supervisionDescendants(parents: ReadonlyMap<ThreadId, ThreadId | null>, parentId: ThreadId) {
  const children = new Map<ThreadId, ThreadId[]>();
  for (const [id, parent] of parents) if (parent !== null) children.set(parent, [...(children.get(parent) ?? []), id]);
  const result: ThreadId[] = [];
  const seen = new Set<ThreadId>([parentId]);
  const pending = [...(children.get(parentId) ?? [])];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]!;
    if (seen.has(id)) continue;
    seen.add(id); result.push(id); pending.push(...(children.get(id) ?? []));
  }
  return result;
}
/** Roll up attention without treating a child's execution as a parent result or sound. */
export function supervisionAttention(parents: ReadonlyMap<ThreadId, ThreadId | null>, attention: ReadonlySet<ThreadId>, parentId: ThreadId) {
  return supervisionDescendants(parents, parentId).some(id => attention.has(id));
}
export const supervisionSoundEligible = (parents: ReadonlyMap<ThreadId, ThreadId | null>, id: ThreadId) => (parents.get(id) ?? null) === null;
import type { EnvironmentThreadShell } from "./models.ts";

export const supervisionKey = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

/** Organizational parentage never substitutes provider execution lineage. */
export function supervisionParentKey(thread: EnvironmentThreadShell): string | null {
  const source = thread.source as EnvironmentThreadShell["source"] & {
    parentThreadId?: string | null;
    parentEnvironmentId?: string | null;
  };
  if (thread.source.remoteParent)
    return `${thread.source.remoteParent.environmentId}:${thread.source.remoteParent.threadId}`;
  return source.parentThreadId == null
    ? null
    : `${source.parentEnvironmentId ?? thread.environmentId}:${source.parentThreadId}`;
}

export function supervisionNeedsAttention(thread: EnvironmentThreadShell): boolean {
  return (
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.hasActionableProposedPlan
  );
}

export function supervisionIsActive(thread: EnvironmentThreadShell): boolean {
  if (thread.settledOverride === "settled") return false;
  if (supervisionNeedsAttention(thread)) return true;
  // The activity-owning run is authoritative, including after stop/interrupt.
  return ["preparing", "starting", "running", "waiting", "queued"].includes(
    thread.runtime?.status ?? "idle",
  );
}

/** A missing, archived, deleted or cyclic parent leaves the child reachable as a root. */
export function supervisionForest(threads: ReadonlyArray<EnvironmentThreadShell>) {
  const byKey = new Map(
    threads
      .filter((t) => t.archivedAt === null && t.deletedAt === null)
      .map((t) => [supervisionKey(t), t]),
  );
  const parentByKey = new Map<string, string>();
  for (const [key, thread] of byKey) {
    const parent = supervisionParentKey(thread);
    if (parent === null || !byKey.has(parent)) continue;
    const seen = new Set([key]);
    let ancestor: string | null = parent;
    while (ancestor !== null && byKey.has(ancestor) && !seen.has(ancestor)) {
      seen.add(ancestor);
      ancestor = supervisionParentKey(byKey.get(ancestor)!);
    }
    if (ancestor !== null && seen.has(ancestor)) continue;
    parentByKey.set(key, parent);
  }
  const children = new Map<string, EnvironmentThreadShell[]>();
  for (const [key, parent] of parentByKey) {
    const group = children.get(parent) ?? [];
    group.push(byKey.get(key)!);
    children.set(parent, group);
  }
  const activeCounts = new Map<string, number>();
  const count = (key: string): number => {
    const cached = activeCounts.get(key);
    if (cached !== undefined) return cached;
    const total = (children.get(key) ?? []).reduce(
      (n, t) => n + Number(supervisionIsActive(t)) + count(supervisionKey(t)),
      0,
    );
    activeCounts.set(key, total);
    return total;
  };
  for (const [key, group] of children) {
    count(key);
    group.sort(
      (a, b) =>
        Number(b.pinnedAt !== null) - Number(a.pinnedAt !== null) ||
        (a.pinnedAt !== null && b.pinnedAt !== null
          ? (a.pinOrderKey ?? "~").localeCompare(b.pinOrderKey ?? "~")
          : 0) ||
        Number(supervisionIsActive(b) || count(supervisionKey(b)) > 0) -
          Number(supervisionIsActive(a) || count(supervisionKey(a)) > 0) ||
        (a.activeOrderKey ?? "~").localeCompare(b.activeOrderKey ?? "~") ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }
  return { byKey, parentByKey, children, activeCounts };
}

export function supervisionVisiblePaths(
  forest: ReturnType<typeof supervisionForest>,
  openedKey: string | null,
) {
  const paths = new Set<string>();
  for (const [key, thread] of forest.byKey) {
    if (key !== openedKey && thread.pinnedAt === null) continue;
    let current: string | undefined = key;
    while (current !== undefined && !paths.has(current)) {
      paths.add(current);
      current = forest.parentByKey.get(current);
    }
  }
  return paths;
}

/** Scoped lists retain the organizational root needed to reach a selected child. */
export function supervisionRoots(
  visible: ReadonlyArray<EnvironmentThreadShell>,
  forest: ReturnType<typeof supervisionForest>,
) {
  const roots = new Map<string, EnvironmentThreadShell>();
  for (const thread of visible) {
    let key = supervisionKey(thread);
    while (forest.parentByKey.has(key)) key = forest.parentByKey.get(key)!;
    const root = forest.byKey.get(key) ?? thread;
    roots.set(key, root);
  }
  return [...roots.values()];
}
