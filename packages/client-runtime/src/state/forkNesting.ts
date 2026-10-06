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
