import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export interface ProjectReturnLocation {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

declare module "@tanstack/react-router" {
  interface HistoryState {
    projectReturn?: ProjectReturnLocation;
  }
}

export function projectReturnState(project: ProjectReturnLocation) {
  return { projectReturn: project };
}

export function isProjectPullRequestDetail(
  projectReturn: ProjectReturnLocation | undefined,
  repository: string | undefined,
  number: number | undefined,
): boolean {
  return projectReturn !== undefined && repository !== undefined && number !== undefined;
}

interface ThreadIdentity {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}

/**
 * The project page a thread belongs to: the orchestrator whose tree contains it, or
 * the orchestrator itself. Null for a standalone thread.
 */
export function owningProjectReturn(
  summaries: ReadonlyArray<{
    readonly root: ThreadIdentity;
    readonly descendants: ReadonlyArray<ThreadIdentity>;
  }>,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): ProjectReturnLocation | null {
  const is = (thread: ThreadIdentity) =>
    thread.environmentId === environmentId && thread.id === threadId;
  const summary = summaries.find((item) => is(item.root) || item.descendants.some(is));
  return summary ? { environmentId: summary.root.environmentId, threadId: summary.root.id } : null;
}
