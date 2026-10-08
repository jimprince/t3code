import {
  isThreadWorking,
  lastActivityAt,
  type OrchestratorSummary,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";

import { issueKey } from "./projectRequests.logic";
import { firstLine, isAfter, type Band, type BandRow } from "./workstreamBands.logic";

/** One tag per thread row; it also sets the sort, what waits on Brad first. */
export type ThreadTag = "waiting" | "error" | "blocked" | "running" | "done";

const THREAD_TAG_ORDER: ReadonlyArray<ThreadTag> = [
  "waiting",
  "error",
  "blocked",
  "running",
  "done",
];

export const THREAD_TAG_LABEL: Record<ThreadTag, string> = {
  waiting: "waiting on you",
  error: "error",
  blocked: "blocked",
  running: "running",
  done: "done",
};

/** A thread, or a task with no thread that needs Brad or is blocked. */
export interface ThreadRow {
  readonly key: string;
  readonly tag: ThreadTag;
  readonly title: string;
  /** The thread to open; null for a task that has none. */
  readonly threadId: string | null;
  /** The task the row stands for or serves; null for a thread on none. */
  readonly issue: ProjectIssue | null;
  /** The thread's own newest words (or the task's blocked cause), one line. */
  readonly latest: string | null;
  /** When it last did something, for the age. */
  readonly at: string;
  /** "blocked, stuck 4d": why a task or thread counts as blocked. */
  readonly note: string | null;
  /** "3 of 5 steps" from a running thread's own to-do list. */
  readonly steps: string | null;
}

/** Done rows shown per group before the rest fold into a count. */
export const DONE_PER_GROUP = 3;

interface ThreadContext {
  readonly since: string | null;
  /** Why each blocked or failed worker is, by thread id (see blockedNotes). */
  readonly workerNotes: ReadonlyMap<string, string>;
}

/** A thread's tag, or null when it has nothing to say: idle and not newly finished. */
export function threadTag(thread: OrchestratorThreadShell, input: ThreadContext): ThreadTag | null {
  if (thread.archivedAt !== null || thread.settledOverride === "settled") return null;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "waiting";
  if (thread.runtime?.status === "failed" || thread.latestRun?.status === "failed") {
    return input.workerNotes.get(thread.id)?.startsWith("failed") === false ? "blocked" : "error";
  }
  if (input.workerNotes.has(thread.id)) return "blocked";
  if (isThreadWorking(thread)) return "running";
  const finishedAt = thread.latestRun?.completedAt;
  if (finishedAt != null && input.since !== null && isAfter(finishedAt, input.since)) return "done";
  return null;
}

const rank = (row: ThreadRow) => THREAD_TAG_ORDER.indexOf(row.tag);
const sortRows = (rows: ThreadRow[]) =>
  rows.toSorted((a, b) => rank(a) - rank(b) || Date.parse(b.at) - Date.parse(a.at));

function threadRow(
  thread: OrchestratorThreadShell,
  tag: ThreadTag,
  issue: ProjectIssue | null,
  note: string | null,
  workerNotes: ReadonlyMap<string, string>,
): ThreadRow {
  return {
    key: `thread:${thread.id}`,
    tag,
    title: thread.title,
    threadId: thread.id,
    issue,
    latest: firstLine(thread.source.workerSummary?.output),
    at: lastActivityAt(thread),
    note: workerNotes.get(thread.id) ?? note,
    steps:
      tag === "running" && thread.todoProgress && thread.todoProgress.total > 0
        ? `${thread.todoProgress.completed} of ${thread.todoProgress.total} steps`
        : null,
  };
}

/** Why a task counts as blocked: nobody has touched it for days, or it waits on open issues. */
const taskNote = (row: BandRow) =>
  row.blockedNote ??
  (row.blockedBy.length > 0
    ? `blocked by ${row.blockedBy.map((number) => `#${number}`).join(", ")}`
    : null);

/** A task that has no thread to speak for it. */
function taskRow(row: BandRow, tag: "waiting" | "blocked"): ThreadRow {
  return {
    key: `task:${issueKey(row.issue)}`,
    tag,
    title: row.issue.title,
    threadId: null,
    issue: row.issue,
    latest: row.latest,
    at: row.issue.updatedAt,
    note: taskNote(row),
    steps: null,
  };
}

interface Tree {
  readonly threadsById: ReadonlyMap<string, OrchestratorThreadShell>;
  readonly rootId: string;
  readonly context: ThreadContext;
  /** Standing agents: they have their own strip, so they are not thread rows. */
  readonly exclude: ReadonlySet<string>;
}

/** The project's freelancer threads linked to a task: neither the orchestrator nor the Team. */
const threadsOf = (issue: ProjectIssue, tree: Tree) =>
  issue.linkedThreadIds.flatMap((id) =>
    id === tree.rootId || tree.exclude.has(id) ? [] : (tree.threadsById.get(id) ?? []),
  );

/**
 * The rows for one task of a workstream: its threads that have something to say,
 * and the task itself when it waits on Brad (unless one of its threads already
 * asks) or is blocked with no thread to carry the note. A task waiting on Brad is
 * the news, so its finished threads stay quiet.
 */
function rowsOfTask(row: BandRow, tree: Tree, seen: Set<string>, claimed: Set<string>) {
  const rows: ThreadRow[] = [];
  const waiting = row.status === "for-review";
  const note = taskNote(row);
  for (const thread of threadsOf(row.issue, tree)) {
    claimed.add(thread.id);
    const tag = threadTag(thread, tree.context);
    if (tag === null || seen.has(thread.id) || (waiting && tag === "done")) continue;
    seen.add(thread.id);
    rows.push(threadRow(thread, tag, row.issue, note, tree.context.workerNotes));
  }
  if (waiting) {
    if (!rows.some((existing) => existing.tag === "waiting")) rows.push(taskRow(row, "waiting"));
  } else if (note !== null && rows.length === 0) {
    rows.push(taskRow(row, "blocked"));
  }
  return rows;
}

/**
 * The rows under a workstream: the threads on its tasks and on the epic itself,
 * and tasks as described by rowsOfTask. Finished threads of completed tasks still
 * count as "done since you looked". Sorted waiting on you, error, blocked, running, done.
 */
function rowsOfBand(band: Band, tree: Tree, claimed: Set<string>): ThreadRow[] {
  const seen = new Set<string>();
  const rows = band.rows.flatMap((row) => rowsOfTask(row, tree, seen, claimed));
  const adopt = (issue: ProjectIssue, accept: (tag: ThreadTag) => boolean) => {
    for (const thread of threadsOf(issue, tree)) {
      claimed.add(thread.id);
      const tag = threadTag(thread, tree.context);
      if (tag === null || seen.has(thread.id) || !accept(tag)) continue;
      seen.add(thread.id);
      rows.push(threadRow(thread, tag, issue, null, tree.context.workerNotes));
    }
  };
  band.complete.forEach((row) => adopt(row.issue, (tag) => tag === "done"));
  if (band.epic) adopt(band.epic, () => true);
  return sortRows(rows);
}

export interface ThreadView {
  /** Rows per band key. */
  readonly byBand: ReadonlyMap<string, ReadonlyArray<ThreadRow>>;
  /** Threads on no workstream's tasks, and tasks outside every workstream that need a look. */
  readonly other: ReadonlyArray<ThreadRow>;
}

/**
 * The Dashboard's thread rows (#178): every workstream's threads, and Other threads
 * for the project's sub-agents outside any workstream plus tasks outside every
 * workstream that wait on Brad or are blocked with no thread. A thread linked to a
 * task of a workstream is that workstream's, however it is tagged.
 */
export function deriveThreadView(input: {
  readonly bands: ReadonlyArray<Band>;
  readonly summary: Pick<OrchestratorSummary, "root" | "descendants">;
  readonly workerNotes: ReadonlyMap<string, string>;
  readonly since: string | null;
  /** Standing agents (the Team strip's), who are not freelancers to list under Other threads. */
  readonly exclude?: ReadonlySet<string>;
}): ThreadView {
  const { bands, summary } = input;
  const tree: Tree = {
    threadsById: new Map(
      [summary.root, ...summary.descendants].map((thread) => [thread.id as string, thread]),
    ),
    rootId: summary.root.id,
    context: input,
    exclude: input.exclude ?? new Set(),
  };
  const claimed = new Set<string>();
  const byBand = new Map<string, ReadonlyArray<ThreadRow>>();
  const other: ThreadRow[] = [];
  for (const band of bands) {
    if (band.epic !== null) {
      byBand.set(band.key, rowsOfBand(band, tree, claimed));
      continue;
    }
    // Their threads fall under Other threads below; a task needs its own row only without one.
    for (const row of band.rows) {
      const tags = threadsOf(row.issue, tree).map((thread) => threadTag(thread, input));
      if (row.status === "for-review") {
        if (!tags.includes("waiting")) other.push(taskRow(row, "waiting"));
      } else if (taskNote(row) !== null && tags.every((tag) => tag === null)) {
        other.push(taskRow(row, "blocked"));
      }
    }
  }
  // A thread on a task outside every workstream keeps that task's number and note.
  const taskOfThread = new Map<string, BandRow>();
  for (const band of bands) {
    if (band.epic !== null) continue;
    for (const row of band.rows) {
      for (const id of row.issue.linkedThreadIds)
        if (!taskOfThread.has(id)) taskOfThread.set(id, row);
    }
  }
  for (const thread of summary.descendants) {
    if (claimed.has(thread.id) || input.exclude?.has(thread.id)) continue;
    const tag = threadTag(thread, input);
    if (tag === null) continue;
    const task = taskOfThread.get(thread.id);
    other.push(
      threadRow(thread, tag, task?.issue ?? null, task ? taskNote(task) : null, input.workerNotes),
    );
  }
  return { byBand, other: sortRows(other) };
}
