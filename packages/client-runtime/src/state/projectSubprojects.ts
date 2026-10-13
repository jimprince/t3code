import type { ThreadPurpose } from "@t3tools/contracts";
import type { ScopedSupervisionMetadata } from "./forkNesting.ts";
import type { OrchestratorSummary, SubagentRow } from "./orchestrators.ts";

/**
 * Subproject rules the mobile Projects list renders, so what counts as top level, a rollup line
 * or a fold hint is decided here rather than in the screen.
 */

export const projectKeyOf = (summary: OrchestratorSummary) =>
  `${summary.root.environmentId}:${summary.root.id}`;

/** Subprojects that are listed inline beneath a project, at any depth; a settled one hides its subtree. */
function visibleSubprojectCount(summary: OrchestratorSummary): number {
  return summary.subprojects
    .filter((sub) => !isSettledProject(sub))
    .reduce((total, sub) => total + 1 + visibleSubprojectCount(sub), 0);
}

/** "1 sub", "3 subs": the hint a folded project card keeps for the rows it hides, null without any. Settled subprojects are not counted: they sit behind their own row. */
export function subprojectCountLabel(summary: OrchestratorSummary): string | null {
  const count = visibleSubprojectCount(summary);
  return count === 0 ? null : `${count} ${count === 1 ? "sub" : "subs"}`;
}

/** Busy now: its workers or its own orchestrator are active, or it is supervising them. */
export const subprojectIsActive = (summary: OrchestratorSummary) =>
  summary.rollup.working > 0 ||
  summary.status === "working" ||
  summary.status === "monitoring" ||
  summary.status === "supervising";

/** The keys with `key` added if it was missing, removed if it was there. */
export const toggleProjectKey = (
  keys: ReadonlyArray<string>,
  key: string,
): ReadonlyArray<string> =>
  keys.includes(key) ? keys.filter((candidate) => candidate !== key) : [...keys, key];

/**
 * How much of a project's work is happening inside its subprojects, for the line under its
 * card ("2 of 6 working in subprojects"). Null when none of it is.
 */
export function subprojectWorkingLabel(summary: OrchestratorSummary): string | null {
  const total = summary.rollup.working;
  const inSubprojects = total - summary.activeWorkerCount;
  if (inSubprojects <= 0) return null;
  return inSubprojects === total
    ? `${total} working in subprojects`
    : `${inSubprojects} of ${total} working in subprojects`;
}

/** The projects a client lists on their own; subprojects appear nested inside these. */
export const topLevelProjects = (summaries: ReadonlyArray<OrchestratorSummary>) =>
  summaries.filter((summary) => summary.parentProjectKey === null);

/** A settled (or retired) subproject: done with, so lists fold it away and tallies skip it. */
export const isSettledProject = (summary: OrchestratorSummary) =>
  summary.root.settledOverride === "settled";

/** A project's direct subprojects split into the ones listed inline and the settled ones, order kept. */
export function splitSettledSubprojects(subprojects: ReadonlyArray<OrchestratorSummary>): {
  readonly active: ReadonlyArray<OrchestratorSummary>;
  readonly settled: ReadonlyArray<OrchestratorSummary>;
} {
  return {
    active: subprojects.filter((sub) => !isSettledProject(sub)),
    settled: subprojects.filter(isSettledProject),
  };
}

/**
 * Tasks done of tasks known, for a project and its non-settled subprojects. `unknown` counts
 * the linked issues with no synced snapshot: they are in neither number, since nothing says
 * whether they are open or done.
 */
export interface TaskProgress {
  readonly done: number;
  readonly total: number;
  readonly unknown: number;
}

type TaskState = "open" | "closed" | "unknown";

/** Each task linked in the project and its non-settled subprojects once; open wins over closed. */
function scopedTasks(summary: OrchestratorSummary): ReadonlyMap<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  const visit = (project: OrchestratorSummary) => {
    for (const issue of project.issues) {
      const key = `${issue.host}/${issue.repository}#${issue.number}`;
      // The snapshot is required by the contract, but a link can still arrive before its first sync.
      const state: TaskState = issue.snapshot?.state ?? "unknown";
      const known = tasks.get(key);
      // A task linked twice is open when any link says so, else closed when any link says so.
      if (known === undefined || state === "open" || (state === "closed" && known === "unknown")) {
        tasks.set(key, state);
      }
    }
    // A settled subproject drops out whole, nested subprojects included.
    project.subprojects.filter((sub) => !isSettledProject(sub)).forEach(visit);
  };
  visit(summary);
  return tasks;
}

/** The done/total tally every surface shows for a project or subproject row. */
export function taskProgress(summary: OrchestratorSummary): TaskProgress {
  let done = 0;
  let total = 0;
  let unknown = 0;
  for (const state of scopedTasks(summary).values()) {
    if (state === "unknown") unknown += 1;
    else {
      total += 1;
      if (state === "closed") done += 1;
    }
  }
  return { done, total, unknown };
}

/** "24/36": the compact fraction, null when no task is known. */
export const taskProgressFraction = (progress: TaskProgress): string | null =>
  progress.total === 0 ? null : `${progress.done}/${progress.total}`;

/** "24 of 36 tasks done": the tooltip and accessible label of the fraction. */
export const taskProgressDescription = (progress: TaskProgress): string | null =>
  progress.total === 0 ? null : `${progress.done} of ${progress.total} tasks done`;

/** Every known task is done: surfaces dim the fraction. */
export const taskProgressComplete = (progress: TaskProgress): boolean =>
  progress.total > 0 && progress.done === progress.total;

/** A row's accessible label with the project's task progress appended: "Open Ops subproject, 24 of 36 tasks done". */
export function labelWithTaskProgress(label: string, summary: OrchestratorSummary): string {
  const description = taskProgressDescription(taskProgress(summary));
  return description === null ? label : `${label}, ${description}`;
}

/** A project's subagent rows split into the ones listed inline and the settled ones, order kept. */
export function splitSettledSubagents(rows: ReadonlyArray<SubagentRow>): {
  readonly active: ReadonlyArray<SubagentRow>;
  readonly settled: ReadonlyArray<SubagentRow>;
} {
  return {
    active: rows.filter((row) => !row.settled),
    settled: rows.filter((row) => row.settled),
  };
}

/**
 * The subagent rows a project card lists. One whose effective purpose is Harness while the card's
 * is not belongs to the Harness tab, like any Harness root, so it is left out here; an unknown
 * purpose stays where it always was.
 */
export function projectSubagentRows(
  summary: OrchestratorSummary,
  purposes: ReadonlyMap<string, ThreadPurpose | null>,
): ReadonlyArray<SubagentRow> {
  const cardHarness =
    purposes.get(`${summary.root.environmentId}:${summary.root.id}`) === "harness";
  return cardHarness
    ? summary.subagentRows
    : summary.subagentRows.filter(
        (row) => purposes.get(`${row.thread.environmentId}:${row.thread.id}`) !== "harness",
      );
}

/** "1 agent", "3 agents": the hint a folded project card keeps for the subagent rows it hides. Settled ones sit behind the Settled row and are not counted. */
export function subagentCountLabel(rows: ReadonlyArray<SubagentRow>): string | null {
  const count = splitSettledSubagents(rows).active.length;
  return count === 0 ? null : `${count} ${count === 1 ? "agent" : "agents"}`;
}

/**
 * What the collapsed Settled row says: how many settled subprojects and subagents it holds and,
 * when any settled subproject needs you or is blocked, how many (attention beats settled, as in
 * the Quiet bucket), so that work is not hidden silently.
 */
export function settledGroupSummary(
  settled: ReadonlyArray<OrchestratorSummary>,
  settledSubagents: number = 0,
): {
  readonly label: string;
  readonly attention: boolean;
  /** The row's screen-reader name, without the Show/Hide verb. */
  readonly description: string;
} {
  const needsYou = settled.reduce((total, sub) => total + sub.rollup.needsYou, 0);
  const blocked = settled.reduce((total, sub) => total + sub.rollup.blocked, 0);
  const notes = [
    ...(needsYou > 0 ? [`${needsYou} need you`] : []),
    ...(blocked > 0 ? [`${blocked} blocked`] : []),
  ];
  const held = [
    ...(settled.length > 0
      ? [`${settled.length} settled ${settled.length === 1 ? "subproject" : "subprojects"}`]
      : []),
    ...(settledSubagents > 0
      ? [
          `${settledSubagents} settled ${
            settledSubagents === 1 ? "subagent or worker" : "subagents and workers"
          }`,
        ]
      : []),
  ];
  return {
    label: [`Settled (${settled.length + settledSubagents})`, ...notes].join(" · "),
    attention: notes.length > 0,
    description: [held.join(", "), ...notes].join(", "),
  };
}

/** Whether the open page or thread is the project's own (its root or a worker), not a subproject's. */
export const ownTreeContains = (summary: OrchestratorSummary, threadKey: string | null) =>
  threadKey !== null &&
  [summary.root, ...summary.descendants].some(
    (thread) => `${thread.environmentId}:${thread.id}` === threadKey,
  );

/**
 * The thread whose project page owns `start`: the nearest ancestor on the nesting sidecar that is
 * top-level or a subproject, the same rule `buildOrchestratorSummaries` uses to place a worker.
 * `lineageParentId` stands in for a start thread the sidecar has no row for yet (a fresh native
 * subagent). Null when `start` has no parent, so a standalone thread or a project root gets no
 * way back. Reads only the sidecar, so a thread view can ask without subscribing to every shell.
 */
export function owningProjectRoot(
  metadata: ReadonlyArray<ScopedSupervisionMetadata>,
  start: {
    readonly environmentId: string;
    readonly threadId: string;
    readonly lineageParentId?: string | null;
  },
): { readonly environmentId: string; readonly threadId: string } | null {
  const rows = new Map(metadata.map((row) => [`${row.environmentId}:${row.threadId}`, row]));
  const parentOf = (environmentId: string, threadId: string, fallback: string | null) => {
    const row = rows.get(`${environmentId}:${threadId}`);
    if (row === undefined) {
      return fallback === null ? null : { environmentId, threadId: fallback };
    }
    if (row.remoteParent) {
      return {
        environmentId: row.remoteParent.environmentId,
        threadId: row.remoteParent.threadId as string,
      };
    }
    return row.parentThreadId === null ? null : { environmentId, threadId: row.parentThreadId };
  };
  const seen = new Set([`${start.environmentId}:${start.threadId}`]);
  let parent = parentOf(start.environmentId, start.threadId, start.lineageParentId ?? null);
  while (parent !== null) {
    const key = `${parent.environmentId}:${parent.threadId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    const above = parentOf(parent.environmentId, parent.threadId, null);
    if (above === null || rows.get(key)?.subproject === "on") return parent;
    parent = above;
  }
  return null;
}

/** The enclosing projects of a subproject, outermost first; empty for a top-level project. */
export function projectTrail(
  summaries: ReadonlyArray<OrchestratorSummary>,
  summary: OrchestratorSummary,
): ReadonlyArray<OrchestratorSummary> {
  const byKey = new Map(summaries.map((item) => [projectKeyOf(item), item]));
  const trail: OrchestratorSummary[] = [];
  const seen = new Set([projectKeyOf(summary)]);
  let parent = summary.parentProjectKey === null ? undefined : byKey.get(summary.parentProjectKey);
  while (parent && !seen.has(projectKeyOf(parent))) {
    seen.add(projectKeyOf(parent));
    trail.unshift(parent);
    parent = parent.parentProjectKey === null ? undefined : byKey.get(parent.parentProjectKey);
  }
  return trail;
}

/** What the header counts show: the project's own tasks plus what is waiting inside its subprojects. */
export const subprojectNeedsYou = (summary: OrchestratorSummary) =>
  summary.subprojects.reduce((total, sub) => total + sub.rollup.needsYou, 0);
export const subprojectBlocked = (summary: OrchestratorSummary) =>
  summary.subprojects.reduce((total, sub) => total + sub.rollup.blocked, 0);

export const COLLAPSED_SUBPROJECTS_KEY = "t3code:projects:collapsed-subprojects";
export const EXPANDED_SETTLED_KEY = "t3code:projects:expanded-settled";

/** Open known tasks in this project and its active subprojects. */
export const openTaskCount = (summary: OrchestratorSummary): number => {
  const progress = taskProgress(summary);
  return progress.total - progress.done + progress.unknown;
};
