import type {
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Named agents own one resource each, so a named agent's project holds at most
 * one live top-level thread: its current incarnation. Nested threads are its
 * sub-agents and never count. The decider calls these on every path that can
 * add a live root thread (create, import, unarchive, unnest).
 */
export function liveNamedAgentThreads(
  threads: ReadonlyArray<OrchestrationThread>,
  projectId: ProjectId,
  exceptThreadId?: ThreadId,
): OrchestrationThread[] {
  return threads.filter(
    (thread) =>
      thread.projectId === projectId &&
      thread.id !== exceptThreadId &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      (thread.parentThreadId ?? null) === null &&
      thread.remoteParent == null,
  );
}

export function namedAgentOf(
  projects: ReadonlyArray<OrchestrationProject>,
  projectId: ProjectId,
): string | null {
  return projects.find((project) => project.id === projectId)?.permanentAgent?.name ?? null;
}

/** A second live root for this agent, as a rejection message, or null when the slot is free. */
export function namedAgentSlotViolation(input: {
  readonly threads: ReadonlyArray<OrchestrationThread>;
  readonly projects: ReadonlyArray<OrchestrationProject>;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}): string | null {
  const name = namedAgentOf(input.projects, input.projectId);
  if (name === null) return null;
  const live = liveNamedAgentThreads(input.threads, input.projectId, input.threadId)[0];
  return live === undefined
    ? null
    : `Named agent '${name}' already has a live thread (${live.id}). Send to it, or hand it over.`;
}

/** An incarnation may hand over only between turns, so two never act at once. */
export function namedAgentThreadIsBusy(thread: OrchestrationThread): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.latestTurn?.state === "running"
  );
}
