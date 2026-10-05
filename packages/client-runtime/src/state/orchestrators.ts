import type { ThreadIssueLink, ThreadPullRequestLink } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import {
  resolveThreadDisplayStatus,
  threadActivityKey,
  threadParentKey,
  reachableNestedThreadKeys,
  type ThreadDisplayStatus,
} from "./threadStatus.ts";

export interface OrchestratorAttentionItem {
  readonly kind: "approval" | "input" | "plan";
  readonly thread: EnvironmentThreadShell;
}

export interface OrchestratorWorkingItem {
  readonly thread: EnvironmentThreadShell;
  readonly latestLine: string | null;
}

export interface OrchestratorDoneItem {
  readonly thread: EnvironmentThreadShell;
  readonly completedAt: string;
}

export interface OrchestratorBlockedItem {
  readonly thread: EnvironmentThreadShell;
  readonly latestLine: string | null;
}

export type StandaloneThreadStatus = "approval" | "input" | "plan" | "working" | "completed";

export interface StandaloneThreadItem {
  readonly thread: EnvironmentThreadShell;
  readonly status: StandaloneThreadStatus;
}

export interface StandaloneThreadGroup {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<StandaloneThreadItem>;
}

export interface OrchestratorSummary {
  readonly root: EnvironmentThreadShell;
  readonly descendants: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly status: ThreadDisplayStatus;
  readonly needsYou: ReadonlyArray<OrchestratorAttentionItem>;
  readonly working: ReadonlyArray<OrchestratorWorkingItem>;
  readonly blocked: ReadonlyArray<OrchestratorBlockedItem>;
  readonly activeWorkerCount: number;
  readonly latestActivityAt: string;
  readonly issues: ReadonlyArray<ThreadIssueLink>;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
}

export type ProjectSidebarBucket = "needs-you" | "working" | "idle" | "quiet";

const PROJECT_SIDEBAR_BUCKET_PRIORITY: Record<ProjectSidebarBucket, number> = {
  "needs-you": 0,
  working: 1,
  idle: 2,
  quiet: 3,
};

export function projectSidebarBucket(
  summary: OrchestratorSummary,
  quietCutoffMs: number,
): ProjectSidebarBucket {
  if (summary.needsYou.length > 0) return "needs-you";
  if (
    summary.activeWorkerCount > 0 ||
    summary.status === "working" ||
    summary.status === "monitoring" ||
    summary.status === "supervising"
  ) {
    return "working";
  }
  return Date.parse(summary.latestActivityAt) >= quietCutoffMs ? "idle" : "quiet";
}

function compareStableThreadOrder(
  left: EnvironmentThreadShell,
  right: EnvironmentThreadShell,
): number {
  const leftOrder =
    left.pinnedAt != null ? (left.pinOrderKey ?? null) : (left.activeOrderKey ?? null);
  const rightOrder =
    right.pinnedAt != null ? (right.pinOrderKey ?? null) : (right.activeOrderKey ?? null);
  if (leftOrder !== null || rightOrder !== null) {
    if (leftOrder === null) return 1;
    if (rightOrder === null) return -1;
    const order = leftOrder.localeCompare(rightOrder);
    if (order !== 0) return order;
  }
  return (
    left.title.localeCompare(right.title, undefined, { sensitivity: "base" }) ||
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    threadActivityKey(left).localeCompare(threadActivityKey(right))
  );
}

/** Stable project ordering: live timestamps never reshuffle peers inside one status bucket. */
export function sortOrchestratorSummariesForSidebar(
  summaries: ReadonlyArray<OrchestratorSummary>,
  quietCutoffMs: number,
  displayedBuckets?: ReadonlyMap<string, ProjectSidebarBucket>,
): ReadonlyArray<OrchestratorSummary> {
  const bucketOf = (summary: OrchestratorSummary) =>
    displayedBuckets?.get(threadActivityKey(summary.root)) ??
    projectSidebarBucket(summary, quietCutoffMs);
  // Pinned projects lead, in their pin order, whatever they are doing; the rest
  // follow by what needs Brad first.
  const pinned = (summary: OrchestratorSummary) => (summary.root.pinnedAt != null ? 0 : 1);
  return [...summaries].sort(
    (left, right) =>
      pinned(left) - pinned(right) ||
      (pinned(left) === 0
        ? 0
        : PROJECT_SIDEBAR_BUCKET_PRIORITY[bucketOf(left)] -
          PROJECT_SIDEBAR_BUCKET_PRIORITY[bucketOf(right)]) ||
      compareStableThreadOrder(left.root, right.root),
  );
}

/**
 * Projects mode owns complete orchestrator trees; Threads keeps standalone roots,
 * plus each pinned project root's own row so a pin tops both lists in pin order.
 */
export function threadsVisibleInThreadsMode(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projectsViewEnabled: boolean,
): ReadonlyArray<EnvironmentThreadShell> {
  if (!projectsViewEnabled) return threads;
  const childrenByParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.parentThreadId === null) continue;
    const parentKey = `${thread.environmentId}:${thread.parentThreadId}`;
    const children = childrenByParent.get(parentKey);
    if (children) children.push(thread);
    else childrenByParent.set(parentKey, [thread]);
  }
  const projectThreadKeys = new Set<string>();
  for (const root of threads) {
    const rootKey = threadActivityKey(root);
    if (
      root.archivedAt !== null ||
      root.parentThreadId !== null ||
      (!childrenByParent.has(rootKey) && root.pinnedAt == null)
    ) {
      continue;
    }
    if (root.pinnedAt == null) projectThreadKeys.add(rootKey);
    for (const descendant of collectDescendants(root, childrenByParent)) {
      projectThreadKeys.add(threadActivityKey(descendant));
    }
  }
  return threads.filter((thread) => !projectThreadKeys.has(threadActivityKey(thread)));
}

function hasPlanReady(thread: EnvironmentThreadShell): boolean {
  return (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    thread.session?.status !== "running" &&
    thread.session?.status !== "starting"
  );
}

function latestActivityAt(thread: EnvironmentThreadShell): string {
  return thread.agentPanelSummary?.lastActivityAt ?? thread.updatedAt;
}

function isBlocked(thread: EnvironmentThreadShell): boolean {
  if (thread.archivedAt != null || thread.settledOverride === "settled" || isOwnActive(thread)) {
    return false;
  }
  if (thread.session?.status === "error") return true;
  if (thread.latestTurn?.state === "error") return true;
  return /^blocked\b/i.test(thread.agentPanelSummary?.latestOutput?.trim() ?? "");
}

function isOwnActive(thread: EnvironmentThreadShell): boolean {
  if (thread.archivedAt != null || thread.settledOverride === "settled") return false;
  const status = resolveThreadDisplayStatus({ ...thread, hasActiveDescendants: false });
  return (
    status === "approval" || status === "input" || status === "working" || status === "monitoring"
  );
}

function collectDescendants(
  root: EnvironmentThreadShell,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>,
): ReadonlyArray<EnvironmentThreadShell> {
  const rootKey = threadActivityKey(root);
  const visited = new Set([rootKey]);
  const descendants: EnvironmentThreadShell[] = [];
  const queue = [...(childrenByParent.get(rootKey) ?? [])];
  for (const child of queue) {
    const key = threadActivityKey(child);
    if (visited.has(key)) continue;
    visited.add(key);
    descendants.push(child);
    queue.push(...(childrenByParent.get(key) ?? []));
  }
  return descendants;
}

function uniqueLinks<T>(links: ReadonlyArray<T>, keyOf: (link: T) => string): ReadonlyArray<T> {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = keyOf(link);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Builds the read-only orchestrator projection used by every client surface. */
export function buildOrchestratorSummaries(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
): ReadonlyArray<OrchestratorSummary> {
  const nestedKeys = reachableNestedThreadKeys(threads);
  const childrenByParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    const key = threadParentKey(thread);
    if (thread.archivedAt != null || key === null) continue;
    const children = childrenByParent.get(key);
    if (children) children.push(thread);
    else childrenByParent.set(key, [thread]);
  }
  const projectByKey = new Map<string, EnvironmentProject>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );

  return threads
    .filter(
      (thread) =>
        thread.archivedAt == null &&
        !nestedKeys.has(threadActivityKey(thread)) &&
        // An orchestrator: it has workers, or it is pinned (the chief of staff
        // reports to Brad without workers nested under it).
        ((childrenByParent.get(threadActivityKey(thread))?.length ?? 0) > 0 ||
          thread.pinnedAt != null),
    )
    .map((root) => {
      const descendants = collectDescendants(root, childrenByParent);
      const tree = [root, ...descendants];
      const needsYou = tree.flatMap((thread): OrchestratorAttentionItem[] => [
        ...(thread.hasPendingApprovals ? [{ kind: "approval" as const, thread }] : []),
        ...(thread.hasPendingUserInput ? [{ kind: "input" as const, thread }] : []),
        ...(hasPlanReady(thread) ? [{ kind: "plan" as const, thread }] : []),
      ]);
      const working = descendants.filter(isOwnActive).map((thread) => ({
        thread,
        latestLine: thread.agentPanelSummary?.latestOutput?.trim() || null,
      }));
      const projectKeys = new Set(
        tree.map((thread) => `${thread.environmentId}:${thread.projectId}`),
      );
      const projectList = [...projectKeys].flatMap((key) => {
        const project = projectByKey.get(key);
        return project ? [project] : [];
      });
      const issues = uniqueLinks(
        tree.flatMap((thread) => thread.issues ?? []),
        (issue) => `${issue.host}/${issue.repository}#${issue.number}`,
      );
      const pullRequests = uniqueLinks(
        tree.flatMap((thread) => thread.pullRequests),
        (pullRequest) => `${pullRequest.host}/${pullRequest.repository}#${pullRequest.number}`,
      );
      return {
        root,
        descendants,
        projects: projectList,
        status: resolveThreadDisplayStatus({
          ...root,
          hasActiveDescendants: working.length > 0,
          settled: root.settledOverride === "settled",
        }),
        needsYou,
        working,
        blocked: tree.filter(isBlocked).map((thread) => ({
          thread,
          latestLine: thread.agentPanelSummary?.latestOutput?.trim() || null,
        })),
        activeWorkerCount: working.length,
        latestActivityAt: tree
          .map(latestActivityAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!,
        issues,
        pullRequests,
      };
    });
}

/** Standalone roots worth surfacing below Projects, grouped by their T3 project. */
export function buildStandaloneThreadGroups(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): ReadonlyArray<StandaloneThreadGroup> {
  const nestedKeys = reachableNestedThreadKeys(threads);
  const parentKeys = new Set(
    threads.flatMap((thread) =>
      threadParentKey(thread) === null ? [] : [threadParentKey(thread)!],
    ),
  );
  const statusOf = (thread: EnvironmentThreadShell): StandaloneThreadStatus | null => {
    if (thread.hasPendingApprovals) return "approval";
    if (thread.hasPendingUserInput) return "input";
    if (hasPlanReady(thread)) return "plan";
    const display = resolveThreadDisplayStatus({ ...thread, hasActiveDescendants: false });
    if (display === "working" || display === "monitoring") return "working";
    const visitedAt = lastVisitedAtByThreadKey[threadActivityKey(thread)];
    const completedAt = thread.latestTurn?.completedAt;
    return visitedAt && completedAt && Date.parse(completedAt) > Date.parse(visitedAt)
      ? "completed"
      : null;
  };
  const projectByKey = new Map<string, EnvironmentProject>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const grouped = new Map<string, StandaloneThreadItem[]>();
  for (const thread of threads) {
    if (
      thread.archivedAt != null ||
      nestedKeys.has(threadActivityKey(thread)) ||
      parentKeys.has(threadActivityKey(thread))
    ) {
      continue;
    }
    const status = statusOf(thread);
    if (status === null) continue;
    const key = `${thread.environmentId}:${thread.projectId}`;
    const rows = grouped.get(key) ?? [];
    rows.push({ thread, status });
    grouped.set(key, rows);
  }
  const priority: Record<StandaloneThreadStatus, number> = {
    approval: 5,
    input: 4,
    plan: 3,
    working: 2,
    completed: 1,
  };
  return [...grouped].flatMap(([key, rows]) => {
    const project = projectByKey.get(key);
    if (!project) return [];
    return [
      {
        project,
        threads: [...rows].sort(
          (left, right) =>
            priority[right.status] - priority[left.status] ||
            compareStableThreadOrder(left.thread, right.thread),
        ),
      },
    ];
  });
}

export function orchestratorDoneSince(
  summary: OrchestratorSummary,
  lastVisitedAt: string | null,
): ReadonlyArray<OrchestratorDoneItem> {
  const threshold = lastVisitedAt == null ? Number.NEGATIVE_INFINITY : Date.parse(lastVisitedAt);
  return summary.descendants
    .flatMap((thread): OrchestratorDoneItem[] => {
      if (isOwnActive(thread)) return [];
      const completedAt = thread.settledAt ?? thread.latestTurn?.completedAt ?? null;
      if (completedAt == null || Date.parse(completedAt) <= threshold) return [];
      return [{ thread, completedAt }];
    })
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}
