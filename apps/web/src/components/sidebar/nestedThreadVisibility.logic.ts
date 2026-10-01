import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveNestedThreadKeys } from "../../threadNesting.logic";

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
  | "settledOverride"
> & {
  session?: Pick<NonNullable<EnvironmentThreadShell["session"]>, "status"> | null;
  latestTurn?: Pick<NonNullable<EnvironmentThreadShell["latestTurn"]>, "state"> | null;
};

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
    if (
      thread.settledOverride !== "settled" &&
      (thread.session?.status === "running" ||
        thread.session?.status === "starting" ||
        thread.latestTurn?.state === "running" ||
        thread.hasPendingUserInput ||
        thread.hasPendingApprovals)
    )
      group.activeCount += 1;
    groups.set(parentKey, group);
  }
  for (const group of groups.values())
    group.children.sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  return groups;
}

/** Keep an open child reachable when its siblings are collapsed. */
export function visibleSidebarChildren<
  T extends {
    environmentId: EnvironmentThreadShell["environmentId"];
    id: EnvironmentThreadShell["id"];
  },
>(children: ReadonlyArray<T>, expanded: boolean, viewedKey: string | null): ReadonlyArray<T> {
  return expanded
    ? children
    : children.filter(
        (thread) => scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)) === viewedKey,
      );
}
