import type { OrchestrationThread, ProjectId, ThreadId } from "@t3tools/contracts";

type NestingThread = Pick<
  OrchestrationThread,
  "id" | "projectId" | "parentThreadId" | "archivedAt" | "deletedAt"
>;

/**
 * Why `threadId` cannot be nested under `parentThreadId`, or null when it can.
 * Nesting stays inside one project at this layer. Parentage may be arbitrarily
 * deep, so walking the proposed parent's ancestors is the one place that
 * prevents cycles.
 */
export function threadNestingViolation(input: {
  readonly threads: ReadonlyArray<NestingThread>;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly parentThreadId: ThreadId;
}): string | null {
  if (input.parentThreadId === input.threadId) {
    return "A thread cannot be nested under itself.";
  }
  const live = input.threads.filter((thread) => thread.deletedAt === null);
  const parent = live.find((thread) => thread.id === input.parentThreadId);
  if (!parent) return `Parent thread '${input.parentThreadId}' does not exist.`;
  if (parent.archivedAt !== null) return "Threads cannot be nested under an archived thread.";
  if (parent.projectId !== input.projectId) {
    return "A nested thread must be in the same project as its parent.";
  }

  const byId = new Map(live.map((thread) => [thread.id, thread] as const));
  const visited = new Set<ThreadId>();
  let ancestor: NestingThread | undefined = parent;
  while (ancestor !== undefined) {
    if (ancestor.id === input.threadId) {
      return "A thread cannot be nested under one of its descendants.";
    }
    if (visited.has(ancestor.id)) {
      return "The chosen parent is already part of a nesting cycle.";
    }
    visited.add(ancestor.id);
    ancestor = ancestor.parentThreadId == null ? undefined : byId.get(ancestor.parentThreadId);
  }
  return null;
}
