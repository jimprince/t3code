import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";

import { ProjectAutomationsPanel } from "./ProjectAutomationsPanel";

export function ProjectAutomationsSlot({
  project,
}: {
  readonly project: {
    readonly environmentId: EnvironmentId;
    readonly rootThreadId: ThreadId;
    readonly rootProjectId: ProjectId;
  };
}) {
  return (
    <ProjectAutomationsPanel
      environmentId={project.environmentId}
      projectId={project.rootProjectId}
      rootThreadId={project.rootThreadId}
    />
  );
}
