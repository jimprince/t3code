import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadParentKey } from "@t3tools/client-runtime/state/thread-status";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveNestedThreadKeys } from "../../threadNesting.logic";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";

/** Group reachable nested threads once for the sidebar, including parked children. */
export type SidebarChild = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "parentThreadId"
  | "remoteParent"
  | "archivedAt"
  | "createdAt"
  | "updatedAt"
  | "title"
  | "pinnedAt"
  | "pinOrderKey"
  | "activeOrderKey"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
  | "settledOverride"
> & {
  session?: Pick<NonNullable<EnvironmentThreadShell["session"]>, "status"> | null;
  latestTurn?: Pick<NonNullable<EnvironmentThreadShell["latestTurn"]>, "state"> | null;
};

export type SidebarChildGroup<T extends SidebarChild> = {
  children: T[];
  activeCount: number;
  inputChildren: T[];
};

export type TidiedSidebarChildRow<T extends SidebarChild> =
  | { kind: "thread"; thread: T; depth: number; parentKey: string }
  | { kind: "done"; key: string; count: number; depth: number; expanded: boolean }
  | {
      kind: "burst";
      key: string;
      count: number;
      label: string;
      depth: number;
      expanded: boolean;
    };

const SIDEBAR_CHILD_BURST_WINDOW_MS = 2 * 60 * 1_000;

/** Match ordinary sidebar status, using the shell turn only while session state is absent. */
export function resolveSidebarChildStatus(
  thread: SidebarChild,
  hasActiveDescendants = false,
): SidebarThreadStatus {
  return resolveSidebarThreadStatus({
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    session: thread.session ? { ...thread.session, lastError: null } : null,
    latestTurn: thread.latestTurn,
    backgroundLiveness: thread.backgroundLiveness,
    settledOverride: thread.settledOverride,
    hasActiveDescendants,
  });
}

export function isActiveSidebarChild(thread: SidebarChild): boolean {
  if (thread.settledOverride === "settled") return false;
  const status = resolveSidebarChildStatus(thread);
  return (
    status === "approval" || status === "input" || status === "working" || status === "monitoring"
  );
}

export function groupSidebarChildren<T extends SidebarChild>(
  threads: ReadonlyArray<T>,
  visibleProjectKeys: ReadonlySet<string> | null = null,
) {
  const compareOrderKey = (left: string | null, right: string | null) => {
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    return left.localeCompare(right);
  };
  const eligible =
    visibleProjectKeys === null
      ? threads
      : threads.filter((thread) =>
          visibleProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
        );
  const nested = resolveNestedThreadKeys(eligible);
  const groups = new Map<string, SidebarChildGroup<T>>();
  for (const thread of eligible) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const parentKey = threadParentKey(thread);
    if (!nested.has(key) || thread.archivedAt !== null || parentKey === null) continue;
    const group = groups.get(parentKey) ?? { children: [], activeCount: 0, inputChildren: [] };
    group.children.push(thread);
    groups.set(parentKey, group);
  }
  const activeCountByParent = new Map<string, number>();
  const inputChildrenByParent = new Map<string, T[]>();
  const countActiveDescendants = (parentKey: string, visiting: Set<string>): number => {
    const cached = activeCountByParent.get(parentKey);
    if (cached !== undefined) return cached;
    if (visiting.has(parentKey)) return 0;
    visiting.add(parentKey);
    const count =
      groups.get(parentKey)?.children.reduce((total, child) => {
        const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
        return (
          total + Number(isActiveSidebarChild(child)) + countActiveDescendants(childKey, visiting)
        );
      }, 0) ?? 0;
    visiting.delete(parentKey);
    activeCountByParent.set(parentKey, count);
    return count;
  };
  const collectInputDescendants = (parentKey: string, visiting: Set<string>): T[] => {
    const cached = inputChildrenByParent.get(parentKey);
    if (cached !== undefined) return cached;
    if (visiting.has(parentKey)) return [];
    visiting.add(parentKey);
    const inputChildren =
      groups.get(parentKey)?.children.flatMap((child) => {
        const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
        return [
          ...(child.settledOverride !== "settled" && child.hasPendingUserInput ? [child] : []),
          ...collectInputDescendants(childKey, visiting),
        ];
      }) ?? [];
    visiting.delete(parentKey);
    inputChildrenByParent.set(parentKey, inputChildren);
    return inputChildren;
  };
  for (const [parentKey, group] of groups) {
    group.activeCount = countActiveDescendants(parentKey, new Set());
    group.inputChildren = collectInputDescendants(parentKey, new Set());
    group.children.sort((a, b) => {
      const pinnedDifference = Number(b.pinnedAt != null) - Number(a.pinnedAt != null);
      if (pinnedDifference !== 0) return pinnedDifference;
      if (a.pinnedAt != null && b.pinnedAt != null) {
        const pinnedOrder = compareOrderKey(a.pinOrderKey ?? null, b.pinOrderKey ?? null);
        if (pinnedOrder !== 0) return pinnedOrder;
      }
      const activeDifference =
        Number(
          isActiveSidebarChild(b) ||
            countActiveDescendants(
              scopedThreadKey(scopeThreadRef(b.environmentId, b.id)),
              new Set(),
            ) > 0,
        ) -
        Number(
          isActiveSidebarChild(a) ||
            countActiveDescendants(
              scopedThreadKey(scopeThreadRef(a.environmentId, a.id)),
              new Set(),
            ) > 0,
        );
      if (activeDifference !== 0) return activeDifference;
      if (a.pinnedAt == null && b.pinnedAt == null) {
        const activeOrder = compareOrderKey(a.activeOrderKey ?? null, b.activeOrderKey ?? null);
        if (activeOrder !== 0) return activeOrder;
      }
      return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
    });
  }
  return groups;
}

/** Keep pinned descendants and their nested ancestor path visible through collapsed rows. */
export function sidebarPinnedPathKeys<T extends SidebarChild>(
  groups: ReadonlyMap<string, { readonly children: ReadonlyArray<T> }>,
): ReadonlySet<string> {
  const byKey = new Map<string, T>();
  const pinned: T[] = [];
  for (const group of groups.values()) {
    for (const child of group.children) {
      const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
      byKey.set(childKey, child);
      if (child.pinnedAt != null) pinned.push(child);
    }
  }

  const path = new Set<string>();
  for (const child of pinned) {
    let current: T | undefined = child;
    while (current !== undefined) {
      const currentKey = scopedThreadKey(scopeThreadRef(current.environmentId, current.id));
      if (path.has(currentKey)) break;
      path.add(currentKey);
      const parentKey = threadParentKey(current);
      if (parentKey === null) break;
      current = byKey.get(parentKey);
    }
  }
  return path;
}

/** A settled parent stays in the active shelf while any descendant still needs supervision. */
export function hasActiveSidebarDescendants(
  groups: ReadonlyMap<string, { readonly activeCount: number }>,
  parentKey: string,
): boolean {
  return (groups.get(parentKey)?.activeCount ?? 0) > 0;
}

/** Nested rows on the path to the open thread stay visible through collapsed ancestors. */
export function sidebarNestedPathKeys<T extends SidebarChild>(
  threads: ReadonlyArray<T>,
  viewedKey: string | null,
): ReadonlySet<string> {
  if (viewedKey === null) return new Set();
  const nested = resolveNestedThreadKeys(threads);
  const byKey = new Map(
    threads.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const path = new Set<string>();
  let currentKey: string | null = viewedKey;
  while (currentKey !== null && nested.has(currentKey) && !path.has(currentKey)) {
    path.add(currentKey);
    const current = byKey.get(currentKey);
    currentKey = current === undefined ? null : threadParentKey(current);
  }
  return path;
}

/** Keep an open child reachable when its siblings are collapsed. */
export function visibleSidebarChildren<
  T extends {
    environmentId: EnvironmentThreadShell["environmentId"];
    id: EnvironmentThreadShell["id"];
  },
>(
  children: ReadonlyArray<T>,
  expanded: boolean,
  viewedPathKeys: ReadonlySet<string>,
): ReadonlyArray<T> {
  return expanded
    ? children
    : children.filter((thread) =>
        viewedPathKeys.has(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))),
      );
}

/** Depth-annotated rows consumed directly by the sidebar renderer. */
export function flattenVisibleSidebarChildren<
  T extends {
    environmentId: EnvironmentThreadShell["environmentId"];
    id: EnvironmentThreadShell["id"];
  },
>(input: {
  rootParentKey: string;
  groups: ReadonlyMap<string, { readonly children: ReadonlyArray<T> }>;
  expandedParentKeys: ReadonlySet<string>;
  viewedPathKeys: ReadonlySet<string>;
}): ReadonlyArray<{ thread: T; depth: number }> {
  const rows: Array<{ thread: T; depth: number }> = [];
  const append = (parentKey: string, depth: number, ancestors: Set<string>) => {
    if (ancestors.has(parentKey)) return;
    ancestors.add(parentKey);
    for (const child of visibleSidebarChildren(
      input.groups.get(parentKey)?.children ?? [],
      input.expandedParentKeys.has(parentKey),
      input.viewedPathKeys,
    )) {
      rows.push({ thread: child, depth });
      append(scopedThreadKey(scopeThreadRef(child.environmentId, child.id)), depth + 1, ancestors);
    }
    ancestors.delete(parentKey);
  };
  append(input.rootParentKey, 1, new Set());
  return rows;
}

function commonTitlePrefix(titles: ReadonlyArray<string>): string | null {
  const words = titles.map((title) => title.trim().split(/\s+/));
  const first = words[0];
  if (first === undefined) return null;
  let length = first.length;
  for (const titleWords of words.slice(1)) {
    length = Math.min(length, titleWords.length);
    for (let index = 0; index < length; index += 1) {
      if (
        first[index]!.localeCompare(titleWords[index]!, undefined, { sensitivity: "accent" }) !== 0
      ) {
        length = index;
        break;
      }
    }
  }
  const prefix = first
    .slice(0, length)
    .join(" ")
    .replace(/[\s:–—-]+$/u, "");
  return prefix.length >= 4 ? prefix : null;
}

function untouchedBurstGroups<T extends SidebarChild>(
  children: ReadonlyArray<T>,
): ReadonlyArray<ReadonlyArray<T>> {
  const candidates = children
    .filter(
      (child) =>
        child.pinnedAt == null &&
        !isActiveSidebarChild(child) &&
        child.latestTurn == null &&
        child.updatedAt === child.createdAt &&
        Number.isFinite(Date.parse(child.createdAt)),
    )
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
  const bursts: T[][] = [];
  let current: T[] = [];
  let startedAt = 0;
  for (const child of candidates) {
    const createdAt = Date.parse(child.createdAt);
    if (current.length === 0 || createdAt - startedAt <= SIDEBAR_CHILD_BURST_WINDOW_MS) {
      if (current.length === 0) startedAt = createdAt;
      current.push(child);
      continue;
    }
    if (current.length > 1) bursts.push(current);
    current = [child];
    startedAt = createdAt;
  }
  if (current.length > 1) bursts.push(current);
  return bursts;
}

/** Fold quiet siblings without hiding pinned, supervised, or currently viewed branches. */
export function flattenTidiedSidebarChildren<T extends SidebarChild>(input: {
  rootParentKey: string;
  groups: ReadonlyMap<string, SidebarChildGroup<T>>;
  expandedParentKeys: ReadonlySet<string>;
  viewedPathKeys: ReadonlySet<string>;
  expandedDoneGroupKeys: ReadonlySet<string>;
  expandedBurstGroupKeys: ReadonlySet<string>;
}): ReadonlyArray<TidiedSidebarChildRow<T>> {
  const rows: Array<TidiedSidebarChildRow<T>> = [];
  const appendThread = (thread: T, parentKey: string, depth: number, ancestors: Set<string>) => {
    rows.push({ kind: "thread", thread, parentKey, depth });
    append(scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)), depth + 1, ancestors);
  };
  const append = (parentKey: string, depth: number, ancestors: Set<string>) => {
    if (ancestors.has(parentKey)) return;
    ancestors.add(parentKey);
    const children = input.groups.get(parentKey)?.children ?? [];
    if (!input.expandedParentKeys.has(parentKey)) {
      for (const child of visibleSidebarChildren(children, false, input.viewedPathKeys)) {
        appendThread(child, parentKey, depth, ancestors);
      }
      ancestors.delete(parentKey);
      return;
    }

    const individuallyVisible = new Set<string>();
    for (const child of children) {
      const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
      if (
        child.pinnedAt != null ||
        isActiveSidebarChild(child) ||
        (input.groups.get(childKey)?.activeCount ?? 0) > 0 ||
        input.viewedPathKeys.has(childKey)
      ) {
        individuallyVisible.add(childKey);
      }
    }
    const quiet = children.filter(
      (child) =>
        !individuallyVisible.has(scopedThreadKey(scopeThreadRef(child.environmentId, child.id))),
    );
    const bursts = untouchedBurstGroups(quiet);
    const burstByMember = new Map<string, { key: string; children: ReadonlyArray<T> }>();
    for (const burst of bursts) {
      const key = `burst:${parentKey}:${burst.map((child) => child.id).join(",")}`;
      const entry = { key, children: burst };
      for (const child of burst) {
        burstByMember.set(scopedThreadKey(scopeThreadRef(child.environmentId, child.id)), entry);
      }
    }
    const done = quiet.filter(
      (child) => !burstByMember.has(scopedThreadKey(scopeThreadRef(child.environmentId, child.id))),
    );
    const doneKey = `done:${parentKey}`;
    let renderedDone = false;
    const renderedBursts = new Set<string>();
    for (const child of children) {
      const childKey = scopedThreadKey(scopeThreadRef(child.environmentId, child.id));
      if (individuallyVisible.has(childKey)) {
        appendThread(child, parentKey, depth, ancestors);
        continue;
      }
      const burst = burstByMember.get(childKey);
      if (burst !== undefined) {
        if (renderedBursts.has(burst.key)) continue;
        renderedBursts.add(burst.key);
        const expanded = input.expandedBurstGroupKeys.has(burst.key);
        const prefix = commonTitlePrefix(burst.children.map((entry) => entry.title));
        rows.push({
          kind: "burst",
          key: burst.key,
          count: burst.children.length,
          label:
            prefix === null
              ? `${burst.children.length} created together`
              : `${prefix} · ${burst.children.length}`,
          depth,
          expanded,
        });
        if (expanded) {
          for (const member of burst.children) appendThread(member, parentKey, depth, ancestors);
        }
        continue;
      }
      if (renderedDone || done.length === 0) continue;
      renderedDone = true;
      const expanded = input.expandedDoneGroupKeys.has(doneKey);
      rows.push({ kind: "done", key: doneKey, count: done.length, depth, expanded });
      if (expanded) {
        for (const member of done) appendThread(member, parentKey, depth, ancestors);
      }
    }
    ancestors.delete(parentKey);
  };
  append(input.rootParentKey, 1, new Set());
  return rows;
}
