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
