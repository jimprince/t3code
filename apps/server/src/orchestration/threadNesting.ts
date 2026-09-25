import type { OrchestrationThread, ProjectId, ThreadId } from "@t3tools/contracts";

type NestingThread = Pick<
  OrchestrationThread,
  "id" | "projectId" | "parentThreadId" | "archivedAt" | "deletedAt"
>;

/**
 * Why `threadId` cannot be nested under `parentThreadId`, or null when it can.
 * Nesting is one level deep and stays inside one project, so the sidebar and
 * the parent's Agents panel never have to render a tree or chase a cycle.
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
  if ((parent.parentThreadId ?? null) !== null) {
    return "Threads nest one level deep, and the chosen parent is itself nested.";
  }
  if (live.some((thread) => (thread.parentThreadId ?? null) === input.threadId)) {
    return "This thread has nested threads of its own, so it cannot be nested.";
  }
  return null;
}
