import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping.ts";

export type AllProjectsCheckboxState = "all" | "none" | "partial";

// Hidden keys are stored sorted: settings writes are compared by value
// upstream, and an unsorted array would rewrite the settings file every
// time the project list reorders.
function sortKeys(keys: Iterable<string>): readonly string[] {
  return [...keys].toSorted();
}

export function toggleHiddenProjectKey(
  hiddenProjectKeys: readonly string[],
  projectKey: string,
): readonly string[] {
  const next = new Set(hiddenProjectKeys);
  if (next.has(projectKey)) {
    next.delete(projectKey);
  } else {
    next.add(projectKey);
  }
  return sortKeys(next);
}

export function toggleAllHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): readonly string[] {
  // "All projects" brings every project back. Only when everything is
  // already visible does it clear the list, as a start for picking a few.
  const hidden = new Set(hiddenProjectKeys);
  const allVisible = projectGroups.every((project) => !hidden.has(project.projectKey));
  return allVisible ? sortKeys(projectGroups.map((project) => project.projectKey)) : [];
}

// Clicking a project row shows only that project. Clicking the project that
// is already shown alone brings every project back.
export function isolateProjectKey(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
  projectKey: string,
): readonly string[] {
  if (resolveIsolatedProjectKey(hiddenProjectKeys, projectGroups) === projectKey) return [];
  return sortKeys(
    projectGroups
      .map((project) => project.projectKey)
      .filter((candidateKey) => candidateKey !== projectKey),
  );
}

// The single project the filter leaves visible, or null when it leaves
// several (or the catalog has only one project, so there is nothing to scope).
export function resolveIsolatedProjectKey(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): string | null {
  if (projectGroups.length < 2) return null;
  const hidden = new Set(hiddenProjectKeys);
  const visible = projectGroups.filter((project) => !hidden.has(project.projectKey));
  return visible.length === 1 ? visible[0]!.projectKey : null;
}

export function resolveAllProjectsCheckboxState(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): AllProjectsCheckboxState {
  if (projectGroups.length === 0) return "all";
  const hidden = new Set(hiddenProjectKeys);
  const hiddenCount = projectGroups.filter((project) => hidden.has(project.projectKey)).length;
  if (hiddenCount === 0) return "all";
  if (hiddenCount === projectGroups.length) return "none";
  return "partial";
}

// "environmentId:projectId" keys of the projects whose threads the sidebar
// lists, or null when nothing is hidden so callers can skip filtering.
export function resolveVisibleProjectRefKeys(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): ReadonlySet<string> | null {
  if (hiddenProjectKeys.length === 0) return null;
  const hidden = new Set(hiddenProjectKeys);
  return new Set(
    projectGroups
      .filter((project) => !hidden.has(project.projectKey))
      .flatMap((project) =>
        project.memberProjectRefs.map(
          (projectRef) => `${projectRef.environmentId}:${projectRef.projectId}`,
        ),
      ),
  );
}

export function pruneHiddenProjectKeys(
  hiddenProjectKeys: readonly string[],
  projectGroups: readonly SidebarProjectSnapshot[],
): readonly string[] {
  // An empty project list means "not loaded yet", not "everything was
  // deleted". Pruning here would wipe the persisted selection on the first
  // render after every reload, before the projects it refers to arrive.
  if (projectGroups.length === 0) return hiddenProjectKeys;
  const live = new Set(projectGroups.map((project) => project.projectKey));
  const pruned = hiddenProjectKeys.filter((key) => live.has(key));
  // Identity-stable when nothing was stale: callers use this in effects
  // and a fresh array every render would loop.
  return pruned.length === hiddenProjectKeys.length ? hiddenProjectKeys : pruned;
}
