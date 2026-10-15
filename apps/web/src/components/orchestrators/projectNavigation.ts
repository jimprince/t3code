import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

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

interface ProjectThreads {
  readonly root: ThreadIdentity;
  readonly descendants?: ReadonlyArray<ThreadIdentity>;
}

/**
 * A thread of the project by id, whichever machine it lives on. A project spans machines, so
 * a remote descendant keeps its own environment; the project's own environment wins when an id
 * is reused on another machine.
 */
export function findProjectThread(
  project: ProjectThreads,
  threadId: string,
): ThreadIdentity | undefined {
  const threads = [project.root, ...(project.descendants ?? [])];
  return (
    threads.find(
      (thread) => thread.id === threadId && thread.environmentId === project.root.environmentId,
    ) ?? threads.find((thread) => thread.id === threadId)
  );
}

/**
 * Opens a thread listed on a project page: the thread's own scope, and the project page to come
 * back to. Callers that hold the thread pass its environment; a bare id (a task's linked thread)
 * is looked up among the project's threads, else it is taken to be in the project's environment.
 */
export function projectThreadOpen(
  project: ProjectThreads,
  threadId: string,
  environmentId?: EnvironmentId,
) {
  return {
    ref: scopeThreadRef(
      environmentId ?? findProjectThread(project, threadId)?.environmentId ?? project.root.environmentId,
      threadId as ThreadId,
    ),
    state: projectReturnState({
      environmentId: project.root.environmentId,
      threadId: project.root.id,
    }),
  };
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
