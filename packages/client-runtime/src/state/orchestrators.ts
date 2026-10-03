import type { ThreadIssueLink, ThreadPullRequestLink } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import {
  resolveThreadDisplayStatus,
  threadActivityKey,
  type ThreadDisplayStatus,
} from "./threadStatus.ts";

export interface OrchestratorAttentionItem {
  readonly kind: "approval" | "input";
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

export interface OrchestratorSummary {
  readonly root: EnvironmentThreadShell;
  readonly descendants: ReadonlyArray<EnvironmentThreadShell>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly status: ThreadDisplayStatus;
  readonly needsYou: ReadonlyArray<OrchestratorAttentionItem>;
  readonly working: ReadonlyArray<OrchestratorWorkingItem>;
  readonly activeWorkerCount: number;
  readonly issues: ReadonlyArray<ThreadIssueLink>;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
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
      ]);
      const working = descendants.filter(isOwnActive).map((thread) => ({
        thread,
        latestLine: thread.agentPanelSummary?.latestOutput?.trim() || null,
      }));
      const projectKeys = new Set(
        descendants.map((thread) => `${thread.environmentId}:${thread.projectId}`),
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
        activeWorkerCount: working.length,
        issues,
        pullRequests,
      };
    })
    .sort((left, right) => Date.parse(right.root.updatedAt) - Date.parse(left.root.updatedAt));
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
