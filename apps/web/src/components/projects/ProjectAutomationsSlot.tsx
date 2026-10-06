import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

export function ProjectAutomationsSlot(_props: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly rootThreadId: ThreadId;
    readonly rootProjectId: ProjectId;
  };
}) {
  return null;
}
