import type { ThreadIssueLink, ThreadPullRequestLink } from "@t3tools/contracts";

import type { EnvironmentProject, EnvironmentThreadShell } from "./models.ts";
import {
  connectedSupervisionParents,
  supervisionThreadKey,
  type ScopedSupervisionMetadata,
} from "./forkNesting.ts";
import type { ForkRemoteParent, ThreadId, ThreadSubprojectMode } from "@t3tools/contracts";

/** Organizational fields come from the nesting sidecar, never execution lineage. */
export interface OrchestratorThreadShell extends EnvironmentThreadShell {
  readonly parentThreadId?: ThreadId | null;
  readonly remoteParent?: ForkRemoteParent | null;
  readonly scope?: string | null;
  readonly supervisionParentKey?: string | null;
  /**
   * `on` means "a project in its own right": a nested thread renders as a subproject
   * of its parent, and a top-level thread stays in Projects even with no workers.
   */
  readonly subproject?: ThreadSubprojectMode;
}
export type ThreadDisplayStatus =
  | "approval"
  | "input"
  | "working"
  | "failed"
  | "monitoring"
  | "supervising"
  | "ready";
const threadActivityKey = supervisionThreadKey;
const ACTIVE_RUNTIME_STATUSES = ["preparing", "starting", "running", "waiting", "queued"];

/**
 * Working in the board's sense: an active run or Codex goal, or work the thread itself launched
 * that is still going (subagents, background tasks). Dev servers and monitors do not count; they only watch.
 */
export function isThreadWorking(
  thread: Pick<EnvironmentThreadShell, "runtime" | "pendingBackgroundTasks" | "codexNativeGoal">,
): boolean {
  if (ACTIVE_RUNTIME_STATUSES.includes(thread.runtime?.status ?? "idle")) return true;
  if (thread.codexNativeGoal?.status === "active" && thread.runtime?.status !== "failed")
    return true;
  return thread.pendingBackgroundTasks.some(
    (task) => task.kind !== "command" && task.kind !== "monitor",
  );
}

/**
 * Effective visited watermark for a thread. Servers with visited tracking project `lastVisitedAt`
 * on the shell and are authoritative, including a `null` for "never visited" and the explicit
 * rewind of mark-unread, which a newer browser-local watermark must not mask. Pre-tracking
 * servers omit the field, and the browser's locally persisted watermark keeps working there.
 */
export function resolveThreadLastVisitedAt(
  serverLastVisitedAt: string | null | undefined,
  localLastVisitedAt: string | undefined,
): string | undefined {
  if (serverLastVisitedAt === undefined) return localLastVisitedAt;
  return serverLastVisitedAt ?? undefined;
}

/** When a thread last did something, which the V2 `updatedAt` is not (settling and pinning bump it). */
export function lastActivityAt(
  thread: Pick<
    EnvironmentThreadShell,
    "latestRun" | "runtime" | "latestUserMessageAt" | "createdAt"
  >,
): string {
  const candidates = [
    thread.latestRun?.completedAt ?? thread.latestRun?.startedAt,
    thread.runtime?.activityStartedAt,
    thread.latestUserMessageAt,
  ].filter((value): value is string => value != null && !Number.isNaN(Date.parse(value)));
  return candidates.reduce(
    (latest, value) => (Date.parse(value) > Date.parse(latest) ? value : latest),
    thread.createdAt,
  );
}

function resolveThreadDisplayStatus(
  thread: OrchestratorThreadShell & { hasActiveDescendants?: boolean; settled?: boolean },
): ThreadDisplayStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (ACTIVE_RUNTIME_STATUSES.includes(thread.runtime?.status ?? "idle")) return "working";
  if (thread.runtime?.status === "failed") return "failed";
  if (isThreadWorking(thread)) return "working";
  if (
    thread.pendingBackgroundTasks.some((task) => task.kind === "monitor" || task.kind === "command")
  )
    return "monitoring";
  if (thread.settled !== true && thread.hasActiveDescendants === true) return "supervising";
  return "ready";
}
function parentKey(thread: OrchestratorThreadShell) {
  return thread.supervisionParentKey === undefined
    ? thread.remoteParent
      ? `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`
      : thread.parentThreadId == null
        ? null
        : `${thread.environmentId}:${thread.parentThreadId}`
    : thread.supervisionParentKey;
}
export function joinOrchestratorMetadata(
  threads: ReadonlyArray<OrchestratorThreadShell>,
  metadata: ReadonlyArray<ScopedSupervisionMetadata>,
): ReadonlyArray<OrchestratorThreadShell> {
  const parents = connectedSupervisionParents(threads, metadata);
  const rows = new Map(metadata.map((row) => [`${row.environmentId}:${row.threadId}`, row]));
  return threads.map((thread) => {
    const row = rows.get(threadActivityKey(thread));
    return {
      ...thread,
      parentThreadId: row?.parentThreadId ?? null,
      remoteParent: row?.remoteParent ?? null,
      scope: row?.scope ?? null,
      subproject: row?.subproject ?? thread.subproject ?? "auto",
      supervisionParentKey: parents.get(threadActivityKey(thread)) ?? null,
    };
  });
}

export interface OrchestratorAttentionItem {
  readonly kind: "approval" | "input" | "plan";
  readonly thread: OrchestratorThreadShell;
}

export interface OrchestratorWorkingItem {
  readonly thread: OrchestratorThreadShell;
  readonly latestLine: string | null;
}

export interface OrchestratorDoneItem {
  readonly thread: OrchestratorThreadShell;
  readonly completedAt: string;
}

export interface OrchestratorBlockedItem {
  readonly thread: OrchestratorThreadShell;
  readonly latestLine: string | null;
}

export type StandaloneThreadStatus = "approval" | "input" | "plan" | "working" | "completed";

export interface StandaloneThreadItem {
  readonly thread: OrchestratorThreadShell;
  readonly status: StandaloneThreadStatus;
}

export interface StandaloneThreadGroup {
  readonly project: EnvironmentProject;
  readonly threads: ReadonlyArray<StandaloneThreadItem>;
}

/** One project and every subproject beneath it, for the sidebar rollup line and the page header. */
export interface OrchestratorRollup {
  readonly needsYou: number;
  readonly working: number;
  readonly blocked: number;
  readonly latestActivityAt: string;
}

/**
 * A project is a top-level orchestrator or a subproject: a nested thread whose mode is `on`.
 * Everything but `rollup`, `subprojects` and `status` covers only the project's own tree, the same
 * threads the server scopes its page data to; a subproject's tree is its own summary. `status`
 * counts subproject work as the root's workers.
 */
export interface OrchestratorSummary {
  readonly root: OrchestratorThreadShell;
  /** Own workers only; a subproject and everything beneath it is left out. */
  readonly descendants: ReadonlyArray<OrchestratorThreadShell>;
  /** Direct subprojects, each a full summary also present in the returned list. */
  readonly subprojects: ReadonlyArray<OrchestratorSummary>;
  /** The enclosing project's root key, or null for a top-level project. */
  readonly parentProjectKey: string | null;
  readonly rollup: OrchestratorRollup;
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
  const { rollup } = summary;
  if (rollup.needsYou > 0) return "needs-you";
  if (
    rollup.working > 0 ||
    summary.status === "working" ||
    summary.status === "monitoring" ||
    summary.status === "supervising"
  ) {
    return "working";
  }
  // Settling is the explicit "this project is finished" statement, so it folds the
  // row away now instead of waiting out the quiet window. Attention and live work
  // above still win: a settled project whose workers need you stays in the list.
  if (summary.root.settledOverride === "settled") return "quiet";
  return Date.parse(rollup.latestActivityAt) >= quietCutoffMs ? "idle" : "quiet";
}

function compareStableThreadOrder(
  left: OrchestratorThreadShell,
  right: OrchestratorThreadShell,
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
 * Projects mode owns complete orchestrator trees, root included, so a project and
 * its orchestrator never also occupy the Threads list (Brad, 2026-10-10). Threads
 * keeps standalone roots.
 */
export function threadsVisibleInThreadsMode(
  threads: ReadonlyArray<OrchestratorThreadShell>,
  projectsViewEnabled: boolean,
): ReadonlyArray<OrchestratorThreadShell> {
  if (!projectsViewEnabled) return threads;
  const childrenByParent = new Map<string, OrchestratorThreadShell[]>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || parentKey(thread) == null) continue;
    const key = parentKey(thread)!;
    const children = childrenByParent.get(key);
    if (children) children.push(thread);
    else childrenByParent.set(key, [thread]);
  }
  const projectThreadKeys = new Set<string>();
  for (const root of threads) {
    const rootKey = threadActivityKey(root);
    if (
      root.archivedAt !== null ||
      parentKey(root) != null ||
      !(childrenByParent.has(rootKey) || root.subproject === "on")
    ) {
      continue;
    }
    projectThreadKeys.add(rootKey);
    for (const descendant of collectDescendants(root, childrenByParent)) {
      projectThreadKeys.add(threadActivityKey(descendant));
    }
  }
  return threads.filter((thread) => !projectThreadKeys.has(threadActivityKey(thread)));
}

function hasPlanReady(thread: OrchestratorThreadShell): boolean {
  return (
    thread.interactionMode === "plan" &&
    thread.hasActionableProposedPlan &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    !["preparing", "running", "starting"].includes(thread.runtime?.status ?? "idle")
  );
}

function latestActivityAt(thread: OrchestratorThreadShell): string {
  return lastActivityAt(thread);
}

function isBlocked(thread: OrchestratorThreadShell): boolean {
  if (thread.archivedAt != null || thread.settledOverride === "settled" || isOwnActive(thread)) {
    return false;
  }
  if (thread.runtime?.status === "failed") return true;
  if (thread.latestRun?.status === "failed") return true;
  return /^blocked\b/i.test(thread.source.workerSummary?.output?.trim() ?? "");
}

function isOwnActive(thread: OrchestratorThreadShell): boolean {
  if (thread.archivedAt != null || thread.settledOverride === "settled") return false;
  const status = resolveThreadDisplayStatus({ ...thread, hasActiveDescendants: false });
  return (
    status === "approval" || status === "input" || status === "working" || status === "monitoring"
  );
}

function collectDescendants(
  root: OrchestratorThreadShell,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<OrchestratorThreadShell>>,
): ReadonlyArray<OrchestratorThreadShell> {
  const rootKey = threadActivityKey(root);
  const visited = new Set([rootKey]);
  const descendants: OrchestratorThreadShell[] = [];
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

/** The workers a project owns: `collectDescendants` without any subproject or what is beneath it. */
function collectOwnDescendants(
  root: OrchestratorThreadShell,
  childrenByParent: ReadonlyMap<string, ReadonlyArray<OrchestratorThreadShell>>,
): ReadonlyArray<OrchestratorThreadShell> {
  const rootKey = threadActivityKey(root);
  const visited = new Set([rootKey]);
  const descendants: OrchestratorThreadShell[] = [];
  const queue = [...(childrenByParent.get(rootKey) ?? [])];
  for (const child of queue) {
    const key = threadActivityKey(child);
    if (visited.has(key) || child.subproject === "on") continue;
    visited.add(key);
    descendants.push(child);
    queue.push(...(childrenByParent.get(key) ?? []));
  }
  return descendants;
}

/** Builds the read-only orchestrator projection used by every client surface. */
export function buildOrchestratorSummaries(
  threads: ReadonlyArray<OrchestratorThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  metadata?: ReadonlyArray<ScopedSupervisionMetadata>,
): ReadonlyArray<OrchestratorSummary> {
  if (metadata !== undefined) threads = joinOrchestratorMetadata(threads, metadata);
  const childrenByParent = new Map<string, OrchestratorThreadShell[]>();
  const byKey = new Map<string, OrchestratorThreadShell>();
  for (const thread of threads) {
    byKey.set(threadActivityKey(thread), thread);
    if (thread.archivedAt != null || parentKey(thread) == null) continue;
    const key = parentKey(thread)!;
    const children = childrenByParent.get(key);
    if (children) children.push(thread);
    else childrenByParent.set(key, [thread]);
  }
  const projectByKey = new Map<string, EnvironmentProject>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const isSubproject = (thread: OrchestratorThreadShell) =>
    thread.subproject === "on" && parentKey(thread) != null;
  /** The enclosing project's root: the first thread above that is top-level or a subproject. */
  const enclosingProjectKey = (thread: OrchestratorThreadShell): string | null => {
    const seen = new Set([threadActivityKey(thread)]);
    let key = parentKey(thread);
    while (key != null && !seen.has(key)) {
      seen.add(key);
      const parent = byKey.get(key);
      if (!parent || parent.archivedAt != null) return null;
      if (parentKey(parent) == null || isSubproject(parent)) return key;
      key = parentKey(parent);
    }
    return null;
  };

  const own = threads
    .filter(
      (thread) =>
        thread.archivedAt == null &&
        (isSubproject(thread)
          ? true
          : // A project: a top-level thread that owns workers, or one marked as a
            // project in its own right (a standing orchestrator between jobs).
            // Pinning only orders the sidebar (Brad, 2026-10-10); it never
            // promotes a thread into Projects.
            parentKey(thread) == null &&
            ((childrenByParent.get(threadActivityKey(thread))?.length ?? 0) > 0 ||
              thread.subproject === "on")),
    )
    .map((root) => {
      const descendants = collectOwnDescendants(root, childrenByParent);
      const tree = [root, ...descendants];
      const needsYou = tree.flatMap((thread): OrchestratorAttentionItem[] => [
        ...(thread.hasPendingApprovals ? [{ kind: "approval" as const, thread }] : []),
        ...(thread.hasPendingUserInput ? [{ kind: "input" as const, thread }] : []),
        ...(hasPlanReady(thread) ? [{ kind: "plan" as const, thread }] : []),
      ]);
      const working = descendants.filter(isOwnActive).map((thread) => ({
        thread,
        latestLine: thread.source.workerSummary?.output?.trim() || null,
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
        needsYou,
        working,
        blocked: tree.filter(isBlocked).map((thread) => ({
          thread,
          latestLine: thread.source.workerSummary?.output?.trim() || null,
        })),
        latestActivityAt: tree
          .map(latestActivityAt)
          .sort((left, right) => Date.parse(right) - Date.parse(left))[0]!,
        issues,
        pullRequests,
      };
    });

  const ownByKey = new Map(own.map((item) => [threadActivityKey(item.root), item]));
  const subprojectKeysByParent = new Map<string, string[]>();
  for (const item of own) {
    const parent = isSubproject(item.root) ? enclosingProjectKey(item.root) : null;
    if (parent === null || !ownByKey.has(parent)) continue;
    const keys = subprojectKeysByParent.get(parent) ?? [];
    keys.push(threadActivityKey(item.root));
    subprojectKeysByParent.set(parent, keys);
  }
  const parentOf = new Map<string, string>();
  for (const [parent, keys] of subprojectKeysByParent) {
    for (const key of keys) parentOf.set(key, parent);
  }

  // Children first, so a project's rollup folds in finished subproject rollups.
  const built = new Map<string, OrchestratorSummary>();
  const build = (key: string, path: ReadonlySet<string>): OrchestratorSummary => {
    const cached = built.get(key);
    if (cached) return cached;
    const item = ownByKey.get(key)!;
    const subprojects = (subprojectKeysByParent.get(key) ?? [])
      .filter((child) => !path.has(child))
      .map((child) => build(child, new Set([...path, key])));
    const sum = (pick: (sub: OrchestratorSummary) => number) =>
      subprojects.reduce((total, sub) => total + pick(sub), 0);
    // A subproject's own orchestrator being busy counts as work on the parent, like any worker.
    const working =
      item.working.length + sum((sub) => sub.rollup.working + Number(isOwnActive(sub.root)));
    const summary: OrchestratorSummary = {
      ...item,
      subprojects,
      parentProjectKey: parentOf.get(key) ?? null,
      status: resolveThreadDisplayStatus({
        ...item.root,
        hasActiveDescendants: working > 0,
        settled: item.root.settledOverride === "settled",
      }),
      activeWorkerCount: item.working.length,
      rollup: {
        needsYou: item.needsYou.length + sum((sub) => sub.rollup.needsYou),
        working,
        blocked: item.blocked.length + sum((sub) => sub.rollup.blocked),
        latestActivityAt: [
          item.latestActivityAt,
          ...subprojects.map((sub) => sub.rollup.latestActivityAt),
        ].sort((left, right) => Date.parse(right) - Date.parse(left))[0]!,
      },
    };
    built.set(key, summary);
    return summary;
  };
  return own.map((item) => build(threadActivityKey(item.root), new Set()));
}

/** Standalone roots worth surfacing below Projects, grouped by their T3 project. */
export function buildStandaloneThreadGroups(
  threads: ReadonlyArray<OrchestratorThreadShell>,
  projects: ReadonlyArray<EnvironmentProject>,
  lastVisitedAtByThreadKey: Readonly<Record<string, string>>,
): ReadonlyArray<StandaloneThreadGroup> {
  const parentKeys = new Set(
    threads.flatMap((thread) => (parentKey(thread) == null ? [] : [parentKey(thread)!])),
  );
  const statusOf = (thread: OrchestratorThreadShell): StandaloneThreadStatus | null => {
    if (thread.hasPendingApprovals) return "approval";
    if (thread.hasPendingUserInput) return "input";
    if (hasPlanReady(thread)) return "plan";
    const display = resolveThreadDisplayStatus({ ...thread, hasActiveDescendants: false });
    if (display === "working" || display === "monitoring") return "working";
    const visitedAt = resolveThreadLastVisitedAt(
      thread.lastVisitedAt,
      lastVisitedAtByThreadKey[threadActivityKey(thread)],
    );
    const completedAt = thread.latestRun?.completedAt;
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
      parentKey(thread) != null ||
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
      const completedAt = thread.settledAt ?? thread.latestRun?.completedAt ?? null;
      if (completedAt == null || Date.parse(completedAt) <= threshold) return [];
      return [{ thread, completedAt }];
    })
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt));
}
