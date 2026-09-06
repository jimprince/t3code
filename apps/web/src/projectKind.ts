import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

/**
 * Project kind is supplied by newer servers but intentionally remains an
 * optional client-side capability while older shell snapshots are supported.
 */
export function isChatProject(project: object): boolean {
  return "kind" in project && project.kind === "chat";
}

export function partitionProjectsByKind<TProject extends object>(
  projects: readonly TProject[],
): { readonly chatProjects: readonly TProject[]; readonly workspaceProjects: readonly TProject[] } {
  const chatProjects: TProject[] = [];
  const workspaceProjects: TProject[] = [];
  for (const project of projects) {
    (isChatProject(project) ? chatProjects : workspaceProjects).push(project);
  }
  return { chatProjects, workspaceProjects };
}

export function selectDefaultThreadProject<TProject extends object>(
  projects: readonly TProject[],
): TProject | null {
  return projects.find((project) => !isChatProject(project)) ?? projects[0] ?? null;
}

// Where a new thread goes when no thread or draft is open: the project of the
// thread the user most recently messaged. Archived threads and threads whose
// project is not loaded are skipped; null leaves the choice to the caller.
export function selectRecentThreadProjectRef(
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly archivedAt: string | null;
    readonly latestUserMessageAt: string | null;
  }>,
  projects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
): ScopedProjectRef | null {
  const loadedProjectKeys = new Set(
    projects.map((project) => `${project.environmentId}:${project.id}`),
  );
  let recent: ScopedProjectRef | null = null;
  let recentAt = "";
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.latestUserMessageAt === null) continue;
    if (!loadedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)) continue;
    if (thread.latestUserMessageAt > recentAt) {
      recent = scopeProjectRef(thread.environmentId, thread.projectId);
      recentAt = thread.latestUserMessageAt;
    }
  }
  return recent;
}

export function selectChatProjectForEnvironment<
  TProject extends { readonly environmentId: unknown; readonly createdAt?: string },
>(projects: readonly TProject[], environmentId: unknown): TProject | null {
  if (environmentId === null || environmentId === undefined) return null;
  const matches = projects.filter(
    (project) => isChatProject(project) && project.environmentId === environmentId,
  );
  return (
    matches.reduce<TProject | null>((selected, project) => {
      if (selected === null) return project;
      return (project.createdAt ?? "") >= (selected.createdAt ?? "") ? project : selected;
    }, null) ?? null
  );
}

export function groupChatProjectsByEnvironment<
  TProject extends { readonly environmentId: unknown },
>(projects: readonly TProject[]): ReadonlyArray<readonly TProject[]> {
  const groups = new Map<unknown, TProject[]>();
  for (const project of projects) {
    const group = groups.get(project.environmentId);
    if (group) group.push(project);
    else groups.set(project.environmentId, [project]);
  }
  return [...groups.values()];
}

export function selectCanonicalChatProjectsByEnvironment<
  TProject extends { readonly environmentId: unknown; readonly createdAt?: string },
>(projects: readonly TProject[]): readonly TProject[] {
  return groupChatProjectsByEnvironment(projects).flatMap((environmentProjects) => {
    const representative = selectChatProjectForEnvironment(
      environmentProjects,
      environmentProjects[0]?.environmentId,
    );
    return representative ? [representative] : [];
  });
}
