import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionIsActive,
  supervisionNeedsAttention,
  supervisionThreadKey,
} from "@t3tools/client-runtime/state/fork-nesting";

export type SupervisionGroup = {
  key: string;
  kind: "quiet" | "burst";
  children: ReadonlyArray<EnvironmentThreadShell>;
};
/** Quiet groups are reversible; active/open/pinned paths never disappear into a group. */
export function groupQuietChildren(input: {
  children: ReadonlyArray<EnvironmentThreadShell>;
  parentKey: string;
  visiblePaths: ReadonlySet<string>;
  activeCounts: ReadonlyMap<string, number>;
}) {
  const visible: EnvironmentThreadShell[] = [];
  const quiet: EnvironmentThreadShell[] = [];
  for (const child of input.children) {
    const key = supervisionThreadKey(child);
    if (
      child.pinnedAt !== null ||
      supervisionIsActive(child) ||
      supervisionNeedsAttention(child) ||
      input.visiblePaths.has(key) ||
      (input.activeCounts.get(key) ?? 0) > 0
    )
      visible.push(child);
    else quiet.push(child);
  }
  const untouched = quiet
    .filter(
      (t) =>
        t.latestRun === null &&
        t.updatedAt === t.createdAt &&
        Number.isFinite(Date.parse(t.createdAt)),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bursts: EnvironmentThreadShell[][] = [];
  let current: EnvironmentThreadShell[] = [];
  let start = 0;
  for (const child of untouched) {
    const time = Date.parse(child.createdAt);
    if (current.length > 0 && time - start > 120000) {
      if (current.length > 1) bursts.push(current);
      current = [];
    }
    if (current.length === 0) start = time;
    current.push(child);
  }
  if (current.length > 1) bursts.push(current);
  const burstKeys = new Set(bursts.flatMap((group) => group.map(supervisionThreadKey)));
  const groups: SupervisionGroup[] = bursts.map((children) => ({
    key: `burst:${input.parentKey}:${children.map((t) => t.id).join(",")}`,
    kind: "burst",
    children,
  }));
  const done = quiet.filter((t) => !burstKeys.has(supervisionThreadKey(t)));
  if (done.length > 0)
    groups.push({ key: `done:${input.parentKey}`, kind: "quiet", children: done });
  return { visible, groups };
}

/** The project name for a child in a different project than its parent; null when it matches or has no known title. */
export function supervisionProjectLabel(
  child: EnvironmentThreadShell,
  parent: EnvironmentThreadShell,
  projectTitles: ReadonlyMap<string, string>,
): string | null {
  if (child.projectId === parent.projectId && child.environmentId === parent.environmentId)
    return null;
  return projectTitles.get(`${child.environmentId}:${child.projectId}`) ?? null;
}

export type SupervisionRow =
  | {
      kind: "thread";
      thread: EnvironmentThreadShell;
      key: string;
      parent: EnvironmentThreadShell;
      depth: number;
      childCount: number;
      activeCount: number;
      expanded: boolean;
    }
  | {
      kind: "group";
      key: string;
      groupKind: SupervisionGroup["kind"];
      label: string;
      depth: number;
      expanded: boolean;
    };

/** Only rows that are actually drawn: collapsed parents and folded groups contribute nothing. */
export function flattenSupervisionChildren(input: {
  root: EnvironmentThreadShell;
  children: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;
  activeCounts: ReadonlyMap<string, number>;
  visiblePaths: ReadonlySet<string>;
  expandedParents: ReadonlySet<string>;
  expandedGroups: ReadonlySet<string>;
}): SupervisionRow[] {
  const rows: SupervisionRow[] = [];
  const walk = (parent: EnvironmentThreadShell, depth: number) => {
    const parentKey = supervisionThreadKey(parent);
    const children = input.children.get(parentKey) ?? [];
    const expanded = input.expandedParents.has(parentKey);
    const emit = (child: EnvironmentThreadShell) => {
      const key = supervisionThreadKey(child);
      const childCount = (input.children.get(key) ?? []).length;
      rows.push({
        kind: "thread",
        thread: child,
        key,
        parent,
        depth,
        childCount,
        activeCount: input.activeCounts.get(key) ?? 0,
        expanded: input.expandedParents.has(key),
      });
      walk(child, depth + 1);
    };
    if (!expanded) {
      for (const child of children)
        if (input.visiblePaths.has(supervisionThreadKey(child))) emit(child);
      return;
    }
    const grouped = groupQuietChildren({
      children,
      parentKey,
      visiblePaths: input.visiblePaths,
      activeCounts: input.activeCounts,
    });
    grouped.visible.forEach(emit);
    for (const group of grouped.groups) {
      const groupExpanded = input.expandedGroups.has(group.key);
      rows.push({
        kind: "group",
        key: group.key,
        groupKind: group.kind,
        label:
          group.kind === "burst"
            ? `${group.children.length} created together`
            : `${group.children.length} done`,
        depth,
        expanded: groupExpanded,
      });
      if (groupExpanded) group.children.forEach(emit);
    }
  };
  walk(input.root, 1);
  return rows;
}
