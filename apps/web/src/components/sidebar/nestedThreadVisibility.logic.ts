import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
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
  | "archivedAt"
  | "createdAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "backgroundLiveness"
  | "settledOverride"
> & {
  session?: Pick<NonNullable<EnvironmentThreadShell["session"]>, "status"> | null;
  latestTurn?: Pick<NonNullable<EnvironmentThreadShell["latestTurn"]>, "state"> | null;
};

/** Match ordinary sidebar status, using the shell turn only while session state is absent. */
export function resolveSidebarChildStatus(thread: SidebarChild): SidebarThreadStatus {
  const status = resolveSidebarThreadStatus({
    hasPendingApprovals: thread.hasPendingApprovals,
    hasPendingUserInput: thread.hasPendingUserInput,
    session: thread.session ? { ...thread.session, lastError: null } : null,
    backgroundLiveness: thread.backgroundLiveness,
  });
  if (status !== "ready" || thread.session != null) return status;
  return thread.latestTurn?.state === "running" ? "working" : status;
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
  const eligible =
    visibleProjectKeys === null
      ? threads
      : threads.filter((thread) =>
          visibleProjectKeys.has(`${thread.environmentId}:${thread.projectId}`),
        );
  const nested = resolveNestedThreadKeys(eligible);
  const groups = new Map<string, { children: T[]; activeCount: number }>();
  for (const thread of eligible) {
    const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    if (!nested.has(key) || thread.archivedAt !== null || thread.parentThreadId == null) continue;
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId));
    const group = groups.get(parentKey) ?? { children: [], activeCount: 0 };
    group.children.push(thread);
    groups.set(parentKey, group);
  }
  const activeCountByParent = new Map<string, number>();
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
  for (const [parentKey, group] of groups) {
    group.activeCount = countActiveDescendants(parentKey, new Set());
    group.children.sort(
      (a, b) =>
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
          ) ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  }
  return groups;
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
    currentKey =
      current?.parentThreadId == null
        ? null
        : scopedThreadKey(scopeThreadRef(current.environmentId, current.parentThreadId));
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
