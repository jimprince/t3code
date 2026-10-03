import type { ThreadIssueLink, ThreadPullRequestLink } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import {
  resolveThreadDisplayStatus,
  threadActivityKey,
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
  if (thread.latestTurn?.state === "error" || thread.latestTurn?.state === "interrupted") {
    return true;
  }
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
  const childrenByParent = new Map<string, EnvironmentThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt != null || thread.parentThreadId == null) continue;
    const key = `${thread.environmentId}:${thread.parentThreadId}`;
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
        thread.parentThreadId == null &&
        (childrenByParent.get(threadActivityKey(thread))?.length ?? 0) > 0,
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
    })
    .sort((left, right) => {
      const attention = Number(right.needsYou.length > 0) - Number(left.needsYou.length > 0);
      if (attention !== 0) return attention;
      const working = Number(right.activeWorkerCount > 0) - Number(left.activeWorkerCount > 0);
      return working || Date.parse(right.latestActivityAt) - Date.parse(left.latestActivityAt);
    });
}

/** Standalone roots worth surfacing below Projects, grouped by their T3 project. */
export function buildStandaloneThreadGroups(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): ReadonlyArray<StandaloneThreadGroup> {
  const parentKeys = new Set(
    threads.flatMap((thread) =>
      thread.parentThreadId == null ? [] : [`${thread.environmentId}:${thread.parentThreadId}`],
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
      thread.parentThreadId != null ||
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
            Date.parse(right.thread.updatedAt) - Date.parse(left.thread.updatedAt),
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
