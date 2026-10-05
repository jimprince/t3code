import type {
  OrchestratorBlockedItem,
  OrchestratorWorkingItem,
} from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";

import {
  answerSentences,
  issueKey,
  requestsByWorker,
  type ProjectRequest,
  type TaskStatus,
} from "./projectRequests.logic";

/** An Active task nobody has touched for this long is stuck. */
const STUCK_AFTER_MS = 3 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NEXT_LINE_MAX_CHARS = 120;

/** One thing that is stuck: what, why, who has it, and what happens next. */
export interface BlockedRow {
  readonly key: string;
  readonly kind: "worker" | "blocked-by" | "stuck";
  readonly title: string;
  readonly cause: string;
  /** The worker thread on it, whose thread the row opens; null when nobody is on it. */
  readonly owner: { readonly id: string; readonly title: string } | null;
  readonly next: string | null;
  /** Only when Brad can unblock it himself, for example "Open #12". */
  readonly action: { readonly label: string; readonly url: string } | null;
}

/** One worker's outcome: the task it is on, what it does next, and who it is. */
export interface WorkingRow {
  readonly key: string;
  readonly threadId: string;
  readonly title: string;
  /** The worker's own name; null when the row is already titled by the worker. */
  readonly worker: string | null;
  readonly next: string | null;
  /** The requests this worker serves, other than the one that titles the row. */
  readonly forRequests: ReadonlyArray<string>;
}

const isOpen = (issue: ProjectIssue) =>
  issue.closedAt === null && issue.status !== "done" && issue.status !== "archived";
const isParked = (issue: ProjectIssue) =>
  issue.labels.some((label) => label.toLowerCase() === "parked");
const lastActivityAt = (thread: EnvironmentThreadShell) =>
  Date.parse(thread.agentPanelSummary?.lastActivityAt ?? thread.updatedAt);

/** A worker's line as a whole first sentence, or null when it is too long to read at a glance. */
function shortLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = answerSentences(text, 1);
  return line.length > 0 && line.length <= NEXT_LINE_MAX_CHARS ? line : null;
}

/** The first line of an agent's "Progress: ..." comment; other comments are not progress. */
function progressNote(body: string | null | undefined): string | null {
  const match = /^\s*progress:\s*(.+)/is.exec((body ?? "").replace(/<!--[\s\S]*?-->/g, ""));
  return match ? shortLine(match[1]!.split("\n")[0]) : null;
}

/** The open tasks a worker thread is linked to, the one it is in progress on first. */
function tasksOfWorker(
  threadId: string,
  issues: ReadonlyArray<ProjectIssue>,
): ReadonlyArray<ProjectIssue> {
  return issues
    .filter(
      (issue) =>
        isOpen(issue) && !isParked(issue) && issue.linkedThreadIds.includes(threadId as never),
    )
    .toSorted(
      (a, b) =>
        Number(b.status === "in-progress") - Number(a.status === "in-progress") ||
        b.updatedAt.localeCompare(a.updatedAt),
    );
}

/** Why a worker counts as blocked: its own "Blocked: ..." line, else that it failed. */
function workerCause(item: OrchestratorBlockedItem): string {
  const line = /^blocked\b[\s:,–—-]*(.*)/is.exec(item.latestLine ?? "");
  const reason = line ? shortLine(line[1]) : null;
  if (reason) return reason;
  return line ? "Blocked" : "Failed";
}

/**
 * Everything stuck on the project, derived and never hand-set: a worker the
 * thread state flags as blocked or failed; an Active task that says "Blocked by
 * #N" while #N is still open; an Active task nobody has touched for 3+ days
 * ("Stuck 4d"), where a linked worker's activity counts as touching it.
 */
export function deriveBlocked(input: {
  readonly blockedWorkers: ReadonlyArray<OrchestratorBlockedItem>;
  readonly issues: ReadonlyArray<ProjectIssue>;
  readonly statuses: ReadonlyMap<string, TaskStatus>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly rootThreadId: string;
  readonly now: number;
}): BlockedRow[] {
  const { issues, statuses, threads, rootThreadId, now } = input;
  const threadById = new Map(threads.map((thread) => [thread.id as string, thread]));
  const openByKey = new Map(issues.filter(isOpen).map((issue) => [issueKey(issue), issue]));

  const workerRows: BlockedRow[] = input.blockedWorkers.map((item) => {
    const task = tasksOfWorker(item.thread.id, issues)[0];
    return {
      key: `worker:${item.thread.id}`,
      kind: "worker",
      title: task?.title ?? item.thread.title,
      cause: workerCause(item),
      owner: { id: item.thread.id, title: item.thread.title },
      next: null,
      action: null,
    };
  });
  const workerIds = new Set(input.blockedWorkers.map((item) => item.thread.id as string));

  const blockedByRows: BlockedRow[] = [];
  const stuckRows: Array<{ readonly row: BlockedRow; readonly idleMs: number }> = [];
  for (const issue of issues) {
    if (!isOpen(issue) || isParked(issue) || statuses.get(issueKey(issue)) !== "active") continue;
    const owners = issue.linkedThreadIds
      .filter((id) => id !== rootThreadId)
      .flatMap((id) => {
        const thread = threadById.get(id);
        return thread ? [thread] : [];
      });
    const owner = owners[0] ? { id: owners[0].id as string, title: owners[0].title } : null;
    const blockers = (issue.blockedBy ?? []).flatMap((number) => {
      const blocker = openByKey.get(issueKey({ repository: issue.repository, number }));
      return blocker ? [blocker] : [];
    });
    if (blockers.length > 0) {
      const first = blockers[0]!;
      blockedByRows.push({
        key: `blocked-by:${issueKey(issue)}`,
        kind: "blocked-by",
        title: issue.title,
        cause: `Blocked by ${blockers.map((blocker) => `#${blocker.number}`).join(", ")}`,
        owner,
        next: `Finish #${first.number}`,
        action: { label: `Open #${first.number}`, url: first.url },
      });
      continue;
    }
    const idleMs =
      now -
      Math.max(Date.parse(issue.updatedAt), ...owners.map((thread) => lastActivityAt(thread)));
    if (idleMs < STUCK_AFTER_MS) continue;
    stuckRows.push({
      row: {
        key: `stuck:${issueKey(issue)}`,
        kind: "stuck",
        title: issue.title,
        cause: `Stuck ${Math.floor(idleMs / DAY_MS)}d`,
        owner,
        next: progressNote(issue.latestComment?.body),
        action: null,
      },
      idleMs,
    });
  }

  return [
    ...workerRows,
    ...blockedByRows,
    ...stuckRows
      // A worker already flagged blocked explains its own stuck task.
      .filter(({ row }) => row.owner === null || !workerIds.has(row.owner.id))
      .toSorted((a, b) => b.idleMs - a.idleMs)
      .map(({ row }) => row),
  ];
}

/**
 * Working now as outcomes: the task each worker is on (its thread's title when
 * it has none), what it does next, and the worker's name; the requests it
 * serves ride along for the "for:" link.
 */
export function deriveWorkingNow(
  working: ReadonlyArray<OrchestratorWorkingItem>,
  issues: ReadonlyArray<ProjectIssue>,
  requests: ReadonlyArray<ProjectRequest>,
): WorkingRow[] {
  const served = requestsByWorker(requests);
  return working.map(({ thread, latestLine }) => {
    const task = tasksOfWorker(thread.id, issues)[0];
    const title = task?.title ?? thread.title;
    return {
      key: thread.id,
      threadId: thread.id,
      title,
      worker: task ? thread.title : null,
      next: progressNote(task?.latestComment?.body) ?? shortLine(latestLine),
      forRequests: (served.get(thread.id) ?? [])
        .map((request) => request.issue.title)
        .filter((requestTitle) => requestTitle !== title),
    };
  });
}
