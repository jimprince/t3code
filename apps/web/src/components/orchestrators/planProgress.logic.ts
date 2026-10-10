import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";

import { taskSteps } from "./taskProgress.logic";
import type { TaskStatus } from "./projectRequests.logic";
import type { Band, BandRow } from "./workstreamBands.logic";

/** The span the Plan measures movement over, and projects one more of. */
export type PlanWindow = "hour" | "4h" | "today";

export const PLAN_WINDOW_LABEL: Record<PlanWindow, string> = {
  hour: "Last hour",
  "4h": "4 hours",
  today: "Today",
};

/** When the window starts: an hour or four ago, or local midnight. */
export function planWindowStart(window: PlanWindow, now: number): number {
  if (window === "hour") return now - 60 * 60 * 1000;
  if (window === "4h") return now - 4 * 60 * 60 * 1000;
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

/**
 * How far a task has come, 0 to 1. Done is all of it and waiting for Brad's review
 * nine tenths. Under way, its working thread's to-do list fills the rest up to nine
 * tenths; without a list it counts a tenth, so it shows as started. Pending is none.
 */
export function taskFraction(
  status: TaskStatus,
  steps: { readonly completed: number; readonly total: number } | null,
): number {
  if (status === "complete") return 1;
  if (status === "for-review") return 0.9;
  if (status === "pending") return 0;
  if (steps === null || steps.total === 0) return 0.1;
  return Math.max(0.1, 0.9 * (steps.completed / steps.total));
}

export interface PlanTask {
  readonly key: string;
  readonly issue: ProjectIssue;
  readonly status: TaskStatus;
  readonly fraction: number;
  readonly steps: { readonly completed: number; readonly total: number } | null;
  /** Closed inside the window. */
  readonly doneInWindow: boolean;
  /** Under way, but neither closed nor touched by a linked thread inside the window. */
  readonly stalled: boolean;
  /** Built and waiting for Brad's review. */
  readonly waitingOnYou: boolean;
}

export interface PlanWorkstream {
  readonly key: string;
  /** Null for the tasks that belong to no workstream. */
  readonly epic: ProjectIssue | null;
  readonly tasks: ReadonlyArray<PlanTask>;
  /** How far it has come, 0 to 1: the mean of its tasks. */
  readonly fraction: number;
  /** The part of `fraction` that tasks finished inside the window. */
  readonly gained: number;
  /** Where the window's pace takes it one window from now, beyond `fraction`. */
  readonly projected: number;
  /** Open tasks, none of which moved inside the window. */
  readonly stalled: boolean;
  readonly waitingOnYou: number;
  readonly doneInWindow: number;
}

const after = (iso: string | null | undefined, start: number) =>
  iso != null && Date.parse(iso) > start;

/** Whether any thread linked to the task changed inside the window. */
function movedInWindow(
  row: BandRow,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
  start: number,
) {
  return row.issue.linkedThreadIds.some((id) => after(threadsById.get(id)?.updatedAt, start));
}

function planTask(
  row: BandRow,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
  start: number,
): PlanTask {
  const steps = row.status === "active" ? taskSteps(row.issue, threadsById) : null;
  const doneInWindow = row.status === "complete" && after(row.issue.closedAt, start);
  return {
    key: `${row.issue.repository}#${row.issue.number}`,
    issue: row.issue,
    status: row.status,
    fraction: taskFraction(row.status, steps),
    steps,
    doneInWindow,
    stalled: row.status === "active" && !movedInWindow(row, threadsById, start),
    waitingOnYou: row.status === "for-review",
  };
}

/**
 * A project's workstreams as the Plan shows them: each one's progress, what its
 * tasks finished inside the window, and where that pace takes it one window
 * ahead. Movement comes from task close times, which the tracker records;
 * a workstream with open tasks that did not move is stalled.
 */
export function derivePlanWorkstreams(input: {
  readonly bands: ReadonlyArray<Band>;
  readonly threadsById: ReadonlyMap<string, OrchestratorThreadShell>;
  readonly windowStart: number;
}): PlanWorkstream[] {
  const { threadsById, windowStart } = input;
  return input.bands.flatMap((band) => {
    if (band.rows.length === 0) return [];
    const tasks = [...band.rows, ...band.complete].map((row) =>
      planTask(row, threadsById, windowStart),
    );
    const fraction = tasks.reduce((total, task) => total + task.fraction, 0) / tasks.length;
    const doneInWindow = tasks.filter((task) => task.doneInWindow).length;
    const gained = doneInWindow / tasks.length;
    const open = band.rows.map((row) => tasks.find((task) => task.issue === row.issue)!);
    const moved =
      doneInWindow > 0 ||
      band.rows.some((row) => movedInWindow(row, threadsById, windowStart)) ||
      (band.epic?.linkedThreadIds ?? []).some((id) =>
        after(threadsById.get(id)?.updatedAt, windowStart),
      );
    return [
      {
        key: band.key,
        epic: band.epic,
        tasks: [...open, ...tasks.filter((task) => task.status === "complete")],
        fraction,
        gained,
        projected: Math.min(1 - fraction, gained),
        stalled: !moved && open.some((task) => task.status === "active"),
        waitingOnYou: open.filter((task) => task.waitingOnYou).length,
        doneInWindow,
      },
    ];
  });
}

/** A project's progress: its workstreams weighted by how many tasks each holds. */
export function planTotals(workstreams: ReadonlyArray<PlanWorkstream>) {
  const tasks = workstreams.reduce((total, stream) => total + stream.tasks.length, 0);
  const weigh = (pick: (stream: PlanWorkstream) => number) =>
    tasks === 0
      ? 0
      : workstreams.reduce((total, stream) => total + pick(stream) * stream.tasks.length, 0) /
        tasks;
  return {
    fraction: weigh((stream) => stream.fraction),
    gained: weigh((stream) => stream.gained),
    projected: weigh((stream) => stream.projected),
    doneInWindow: workstreams.reduce((total, stream) => total + stream.doneInWindow, 0),
    stalled: workstreams.filter((stream) => stream.stalled).length,
  };
}

/** Project titles listed one per line in the widget's Utilities setting, compared case-blind. */
export function parseUtilityTitles(text: unknown): ReadonlySet<string> {
  if (typeof text !== "string") return new Set();
  return new Set(
    text
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0),
  );
}

/** Whole percent for a fraction, for labels. */
export const percent = (fraction: number) => Math.round(fraction * 100);
