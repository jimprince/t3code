import { EnvironmentId, ThreadId, type ForkThreadMetadata } from "@t3tools/contracts";
import { scopedThreadKey, scopeThreadRef } from "../environment/index.ts";

export interface SupervisionThread {
  readonly id: ThreadId;
  readonly projectId: string;
  readonly archivedAt: unknown | null;
}
/** Hidden, archived, absent and cyclic parents cannot make a visible child unreachable. */
function reachableParents<K>(visible: ReadonlySet<K>, raw: ReadonlyMap<K, K | null>) {
  const parents = new Map<K, K | null>();
  for (const id of visible) {
    const parent = raw.get(id) ?? null;
    parents.set(id, parent !== null && visible.has(parent) ? parent : null);
  }
  const processed = new Set<K>();
  for (const id of visible) {
    if (processed.has(id)) continue;
    const path: K[] = [];
    const positions = new Map<K, number>();
    let cursor: K | null = id;
    while (cursor !== null && !processed.has(cursor)) {
      const cycleStart = positions.get(cursor);
      if (cycleStart !== undefined) {
        for (const member of path.slice(cycleStart)) parents.set(member, null);
        break;
      }
      positions.set(cursor, path.length);
      path.push(cursor);
      cursor = parents.get(cursor) ?? null;
    }
    for (const member of path) processed.add(member);
  }
  return parents;
}
export function supervisionParents<T extends SupervisionThread>(
  threads: readonly T[],
  metadata: readonly ForkThreadMetadata[],
) {
  const visible = new Set(
    threads.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
  );
  return reachableParents(
    visible,
    new Map(metadata.map((row) => [row.threadId, row.parentThreadId])),
  );
}
export function supervisionDescendants<K>(parents: ReadonlyMap<K, K | null>, parentId: K) {
  const children = new Map<K, K[]>();
  for (const [id, parent] of parents) {
    if (parent === null) continue;
    const siblings = children.get(parent);
    if (siblings) siblings.push(id);
    else children.set(parent, [id]);
  }
  const result: K[] = [];
  const seen = new Set<K>([parentId]);
  const pending = [...(children.get(parentId) ?? [])];
  for (let i = 0; i < pending.length; i++) {
    const id = pending[i]!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    pending.push(...(children.get(id) ?? []));
  }
  return result;
}
/** Roll up attention without treating a child's execution as a parent result or sound. */
export function supervisionAttention<K>(
  parents: ReadonlyMap<K, K | null>,
  attention: ReadonlySet<K>,
  parentId: K,
) {
  return supervisionDescendants(parents, parentId).some((id) => attention.has(id));
}
export const supervisionSoundEligible = <K>(parents: ReadonlyMap<K, K | null>, id: K) =>
  (parents.get(id) ?? null) === null;

export interface ScopedSupervisionThread extends SupervisionThread {
  readonly environmentId: string;
  readonly forkMetadataAvailable?: boolean;
}
export interface ScopedSupervisionMetadata extends ForkThreadMetadata {
  readonly environmentId: string;
}
/** Stable descriptor IDs disambiguate colliding thread IDs across connected hosts. */
export const supervisionKey = (environmentId: string, threadId: string) =>
  scopedThreadKey(scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId)));
export function connectedSupervisionParents(
  threads: readonly ScopedSupervisionThread[],
  metadata: readonly ScopedSupervisionMetadata[],
) {
  const visible = new Set(
    threads.filter((t) => t.archivedAt === null && t.forkMetadataAvailable !== false).map((t) => supervisionKey(t.environmentId, t.id)),
  );
  const raw = new Map(
    metadata.map((row) => [
      supervisionKey(row.environmentId, row.threadId),
      row.remoteParent
        ? supervisionKey(row.remoteParent.environmentId, row.remoteParent.threadId)
        : row.parentThreadId
          ? supervisionKey(row.environmentId, row.parentThreadId)
          : null,
    ]),
  );
  return reachableParents(visible, raw);
}
import type { EnvironmentThreadShell } from "./models.ts";

export const supervisionThreadKey = (
  thread: Pick<EnvironmentThreadShell, "environmentId" | "id">,
) => supervisionKey(thread.environmentId, thread.id);

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
export function supervisionForest(
  threads: ReadonlyArray<EnvironmentThreadShell & { readonly forkMetadataAvailable?: boolean }>,
  metadata: readonly ScopedSupervisionMetadata[] = [],
) {
  const byKey = new Map(
    threads
      .filter((t) => t.archivedAt === null && t.deletedAt === null)
      .map((t) => [supervisionThreadKey(t), t]),
  );
  const parentByKey = new Map<string, string>();
  for (const [key, parent] of connectedSupervisionParents([...byKey.values()], metadata)) {
    if (parent !== null) parentByKey.set(key, parent);
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
      (n, t) => n + Number(supervisionIsActive(t)) + count(supervisionThreadKey(t)),
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
        Number(supervisionIsActive(b) || count(supervisionThreadKey(b)) > 0) -
          Number(supervisionIsActive(a) || count(supervisionThreadKey(a)) > 0) ||
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
    let key = supervisionThreadKey(thread);
    while (forest.parentByKey.has(key)) key = forest.parentByKey.get(key)!;
    const root = forest.byKey.get(key) ?? thread;
    roots.set(key, root);
  }
  return [...roots.values()];
}
