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
  // Partial counts as "something is visible", so the first click always
  // clears the list rather than needing two clicks from a partial state.
  const hidden = new Set(hiddenProjectKeys);
  const allHidden =
    projectGroups.length > 0 && projectGroups.every((project) => hidden.has(project.projectKey));
  return allHidden ? [] : sortKeys(projectGroups.map((project) => project.projectKey));
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

export interface ProjectScopeResolution {
  readonly effectiveProjectKeys: ReadonlySet<string>;
  /** `null` means "no filtering needed" — every project is visible. */
  readonly scopedProjectRefKeys: ReadonlySet<string> | null;
  readonly allCheckboxState: AllProjectsCheckboxState;
  readonly isolatedProject: SidebarProjectSnapshot | null;
  readonly triggerLabel: string;
  readonly settledResetKey: string;
}

function collectProjectRefKeys(
  projectGroups: readonly SidebarProjectSnapshot[],
): ReadonlySet<string> {
  const refKeys = new Set<string>();
  for (const project of projectGroups) {
    for (const projectRef of project.memberProjectRefs) {
      refKeys.add(`${projectRef.environmentId}:${projectRef.projectId}`);
    }
  }
  return refKeys;
}

export function resolveProjectScope(input: {
  readonly projectGroups: readonly SidebarProjectSnapshot[];
  readonly hiddenProjectKeys: readonly string[];
  readonly isolatedProjectKey: string | null;
}): ProjectScopeResolution {
  const allCheckboxState = resolveAllProjectsCheckboxState(
    input.hiddenProjectKeys,
    input.projectGroups,
  );
  const isolatedProject =
    input.isolatedProjectKey === null
      ? null
      : (input.projectGroups.find((project) => project.projectKey === input.isolatedProjectKey) ??
        null);

  if (isolatedProject !== null) {
    return {
      effectiveProjectKeys: new Set([isolatedProject.projectKey]),
      scopedProjectRefKeys: collectProjectRefKeys([isolatedProject]),
      allCheckboxState,
      isolatedProject,
      triggerLabel: isolatedProject.displayName,
      settledResetKey: `isolated:${isolatedProject.projectKey}`,
    };
  }

  const hidden = new Set(input.hiddenProjectKeys);
  const visibleProjects = input.projectGroups.filter((project) => !hidden.has(project.projectKey));
  const effectiveProjectKeys = new Set(visibleProjects.map((project) => project.projectKey));

  const triggerLabel =
    allCheckboxState === "all"
      ? "All projects"
      : allCheckboxState === "none"
        ? "No projects selected"
        : `${visibleProjects.length} of ${input.projectGroups.length} projects`;

  return {
    effectiveProjectKeys,
    // Everything visible short-circuits the per-thread filter downstream.
    scopedProjectRefKeys:
      allCheckboxState === "all" ? null : collectProjectRefKeys(visibleProjects),
    allCheckboxState,
    isolatedProject: null,
    triggerLabel,
    settledResetKey:
      allCheckboxState === "all"
        ? "all"
        : `selected:${[...effectiveProjectKeys].toSorted().join(" ")}`,
  };
}
