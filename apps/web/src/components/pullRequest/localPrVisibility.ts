import * as Schema from "effect/Schema";
import { useCallback, useMemo, useState } from "react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { pullRequestEntryKey, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

/** A locally removed row is hidden by its environment-qualified identity, never changed upstream. */
export function filterRemovedPullRequests<Entry extends EnvironmentPullRequestEntry>(
  entries: ReadonlyArray<Entry>,
  removedKeys: ReadonlySet<string>,
): ReadonlyArray<Entry> {
  if (removedKeys.size === 0) return entries;
  return entries.filter((entry) => !removedKeys.has(pullRequestEntryKey(entry)));
}

/** Add or remove the rendered rows from a selection without disturbing keys outside that view. */
export function setVisiblePullRequestsSelected(
  selectedKeys: ReadonlySet<string>,
  visibleKeys: ReadonlyArray<string>,
  selected: boolean,
): ReadonlySet<string> {
  const next = new Set(selectedKeys);
  for (const key of visibleKeys) {
    if (selected) next.add(key);
    else next.delete(key);
  }
  return next;
}

const removedPullRequestsStorageKey = (environmentId: string) =>
  `t3.pullRequests.removed:${environmentId}`;
type RemovedPullRequestsStorage = Pick<Storage, "getItem" | "setItem">;
const decodeRemovedPullRequestKeys = Schema.decodeUnknownOption(Schema.Array(Schema.String));

/** Local dismissals are scoped to one environment so one server cannot hide another's rows. */
export function readRemovedPullRequestKeys(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(removedPullRequestsStorageKey(environmentId));
    if (!raw) return new Set();
    const decoded = decodeRemovedPullRequestKeys(JSON.parse(raw));
    return decoded._tag === "Some" ? new Set(decoded.value) : new Set();
  } catch {
    return new Set();
  }
}

export function writeRemovedPullRequestKeys(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
  removedKeys: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(
      removedPullRequestsStorageKey(environmentId),
      JSON.stringify([...removedKeys]),
    );
  } catch {
    // Storage can be full or denied; removals still apply for this renderer session.
  }
}

/** New keys include the provider; legacy host/repository keys remain readable in their own environment. */
export function localPullRequestKey(entry: EnvironmentPullRequestEntry): string {
  return JSON.stringify([
    entry.provider,
    entry.host.toLowerCase(),
    entry.repository.toLowerCase(),
    entry.number,
  ]);
}

function browserStorage(): RemovedPullRequestsStorage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function useLocalPrVisibility(
  environmentIds: ReadonlyArray<EnvironmentId>,
  scopedProjectId?: ProjectId,
) {
  const [excludedStored, setExcludedStored] = useState<ReadonlyMap<string, ReadonlySet<string>>>(
    () => new Map(),
  );
  const excluded = useMemo(
    () =>
      new Map(
        environmentIds.map(
          (id) =>
            [id, excludedStored.get(id) ?? readExcludedProjectIds(browserStorage(), id)] as const,
        ),
      ),
    [environmentIds, excludedStored],
  );
  const [stored, setStored] = useState<ReadonlyMap<string, ReadonlySet<string>>>(() => new Map());
  const removed = useMemo(
    () =>
      new Map(
        environmentIds.map(
          (id) => [id, stored.get(id) ?? readRemovedPullRequestKeys(browserStorage(), id)] as const,
        ),
      ),
    [environmentIds, stored],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const filterQueries = useCallback(
    (
      queries: ReadonlyArray<LocalPrQuery>,
      projects: ReadonlyArray<LocalPrProject>,
      projectsKnown: boolean,
    ) => {
      return scopedProjectId !== undefined || !projectsKnown
        ? queries
        : filterExcludedProjectQueries(queries, projects, excluded);
    },
    [scopedProjectId, excluded],
  );
  return {
    selected,
    excluded,
    excludedCount: [...excluded.values()].reduce((count, ids) => count + ids.size, 0),
    isProjectExcluded(project: { environmentId: EnvironmentId; id: ProjectId }) {
      return excluded.get(project.environmentId)?.has(project.id) ?? false;
    },
    filterQueries,
    excludeProject(project: LocalPrProject, hidden: boolean) {
      setExcludedStored((current) => {
        const next = new Map(current);
        const ids = new Set(
          current.get(project.environmentId) ?? excluded.get(project.environmentId),
        );
        if (hidden) ids.add(project.id);
        else ids.delete(project.id);
        writeExcludedProjectIds(browserStorage(), project.environmentId, ids);
        next.set(project.environmentId, ids);
        return next;
      });
    },
    restoreProjects() {
      const next = new Map(excludedStored);
      for (const id of environmentIds) {
        const empty = new Set<string>();
        writeExcludedProjectIds(browserStorage(), id, empty);
        next.set(id, empty);
      }
      setExcludedStored(next);
    },
    removedCount: [...removed.values()].reduce((count, keys) => count + keys.size, 0),
    filter<Entry extends EnvironmentPullRequestEntry>(
      entries: ReadonlyArray<Entry>,
    ): ReadonlyArray<Entry> {
      return entries.filter((entry) => {
        const keys = removed.get(entry.environmentId);
        return (
          (scopedProjectId !== undefined ||
            !excluded.get(entry.environmentId)?.has(entry.projectId)) &&
          !keys?.has(localPullRequestKey(entry)) &&
          !keys?.has(pullRequestEntryKey(entry))
        );
      });
    },
    select(keys: ReadonlyArray<string>, checked: boolean) {
      setSelected((current) => setVisiblePullRequestsSelected(current, keys, checked));
    },
    dismiss(entries: ReadonlyArray<EnvironmentPullRequestEntry>) {
      setStored((current) => {
        const next = new Map(current);
        for (const id of environmentIds) {
          const keys = new Set(current.get(id) ?? removed.get(id));
          for (const entry of entries) {
            if (entry.environmentId === id && selected.has(pullRequestEntryKey(entry)))
              keys.add(localPullRequestKey(entry));
          }
          writeRemovedPullRequestKeys(browserStorage(), id, keys);
          next.set(id, keys);
        }
        return next;
      });
      setSelected(new Set());
    },
    restore() {
      const next = new Map(stored);
      for (const id of environmentIds) {
        const empty = new Set<string>();
        writeRemovedPullRequestKeys(browserStorage(), id, empty);
        next.set(id, empty);
      }
      setStored(next);
    },
  };
}

export interface LocalPrProject {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}
export interface LocalPrQuery {
  readonly environmentId: EnvironmentId;
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export function readExcludedProjectIds(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(`t3.pullRequests.excludedProjects:${environmentId}`);
    if (!raw) return new Set();
    const decoded = decodeRemovedPullRequestKeys(JSON.parse(raw));
    return decoded._tag === "Some" ? new Set(decoded.value) : new Set();
  } catch {
    return new Set();
  }
}

export function writeExcludedProjectIds(
  storage: RemovedPullRequestsStorage | undefined,
  environmentId: string,
  ids: ReadonlySet<string>,
): void {
  try {
    storage?.setItem(`t3.pullRequests.excludedProjects:${environmentId}`, JSON.stringify([...ids]));
  } catch {
    /* Apply in memory when browser storage is unavailable. */
  }
}

/** Narrow the native ownership assignment, never reassign a hidden repository to another server. */
export function filterExcludedProjectQueries(
  queries: ReadonlyArray<LocalPrQuery>,
  projects: ReadonlyArray<LocalPrProject>,
  excluded: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyArray<LocalPrQuery> {
  return queries.flatMap((query) => {
    const hidden = excluded.get(query.environmentId);
    if (!hidden?.size) return [query];
    const assigned =
      query.projectIds ??
      projects
        .filter((project) => project.environmentId === query.environmentId)
        .map((project) => project.id);
    const projectIds = assigned.filter((id) => !hidden.has(id));
    return projectIds.length === 0 ? [] : [{ ...query, projectIds }];
  });
}
