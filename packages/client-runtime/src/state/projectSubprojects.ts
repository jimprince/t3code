import type { OrchestratorSummary } from "./orchestrators.ts";

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

/**
 * What the collapsed Settled row says: how many subprojects it holds and, when any of them
 * needs you or is blocked, how many (attention beats settled, as in the Quiet bucket), so
 * that work is not hidden silently.
 */
export function settledGroupSummary(settled: ReadonlyArray<OrchestratorSummary>): {
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
  const noun = settled.length === 1 ? "subproject" : "subprojects";
  return {
    label: [`Settled (${settled.length})`, ...notes].join(" · "),
    attention: notes.length > 0,
    description: [`${settled.length} settled ${noun}`, ...notes].join(", "),
  };
}

/** Whether the open page or thread is the project's own (its root or a worker), not a subproject's. */
export const ownTreeContains = (summary: OrchestratorSummary, threadKey: string | null) =>
  threadKey !== null &&
  [summary.root, ...summary.descendants].some(
    (thread) => `${thread.environmentId}:${thread.id}` === threadKey,
  );

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
