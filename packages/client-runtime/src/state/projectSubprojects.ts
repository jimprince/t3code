import type { ThreadPurpose } from "@t3tools/contracts";
import type { ScopedSupervisionMetadata } from "./forkNesting.ts";
import type { OrchestratorSummary, SubagentRow } from "./orchestrators.ts";

/**
 * Subproject rules shared by every client: the web sidebar and project page and the mobile
 * Home list render these, so what counts as top level, a rollup line or a fold hint is decided once.
 */

export const projectKeyOf = (summary: OrchestratorSummary) =>
  `${summary.root.environmentId}:${summary.root.id}`;

/** Whether the open page or thread is the project's own (its root or a worker), not a subproject's. */
export const ownTreeContains = (summary: OrchestratorSummary, threadKey: string | null) =>
  threadKey !== null &&
  [summary.root, ...summary.descendants].some(
    (thread) => `${thread.environmentId}:${thread.id}` === threadKey,
  );

/** Each task linked in the project and every subproject beneath it once, with whether it is closed. */
function linkedTasks(summary: OrchestratorSummary): ReadonlyMap<string, boolean> {
  const tasks = new Map<string, boolean>();
  const visit = (project: OrchestratorSummary) => {
    for (const issue of project.issues) {
      const key = `${issue.host}/${issue.repository}#${issue.number}`;
      // A task is open when any link to it says so, as openTaskCount always counted it.
      tasks.set(key, (tasks.get(key) ?? true) && issue.snapshot?.state === "closed");
    }
    project.subprojects.forEach(visit);
  };
  visit(summary);
  return tasks;
}

/** Open tasks across the project and every subproject beneath it, each linked issue once. */
export function openTaskCount(summary: OrchestratorSummary): number {
  return [...linkedTasks(summary).values()].filter((closed) => !closed).length;
}

/** The Progress column of the subprojects table: tasks closed of tasks linked, null with none. */
export function taskProgressLabel(summary: OrchestratorSummary): string | null {
  const tasks = [...linkedTasks(summary).values()];
  if (tasks.length === 0) return null;
  return `${tasks.filter(Boolean).length} of ${tasks.length}`;
}

/** Every subproject beneath a project, at any depth: what folding its card hides. */
function subprojectCount(summary: OrchestratorSummary): number {
  return summary.subprojects.reduce((total, sub) => total + 1 + subprojectCount(sub), 0);
}

/** "1 sub", "3 subs": the hint a folded project card keeps, null without subprojects. */
export function subprojectCountLabel(summary: OrchestratorSummary): string | null {
  const count = subprojectCount(summary);
  return count === 0 ? null : `${count} ${count === 1 ? "sub" : "subs"}`;
}

/** Every subproject beneath a project, at any depth: what folding its card hides. */
function subprojectCount(summary: OrchestratorSummary): number {
  return summary.subprojects.reduce((total, sub) => total + 1 + subprojectCount(sub), 0);
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

/** Busy now: its workers or its own orchestrator are active, or it is supervising them. */
export const subprojectIsActive = (summary: OrchestratorSummary) =>
  summary.rollup.working > 0 ||
  summary.status === "working" ||
  summary.status === "monitoring" ||
  summary.status === "supervising";

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

/** Subproject cards this device has collapsed in the Projects sidebar; expanded is the default. */
export const COLLAPSED_SUBPROJECTS_KEY = "t3code:projects:collapsed-subprojects";

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
