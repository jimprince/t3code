import type { OrchestratorSummary } from "./orchestrators.ts";

/**
 * Subproject rules the mobile Projects list renders, so what counts as top level, a rollup line
 * or a fold hint is decided here rather than in the screen.
 */

export const projectKeyOf = (summary: OrchestratorSummary) =>
  `${summary.root.environmentId}:${summary.root.id}`;

/** Every subproject beneath a project, at any depth: what folding its card hides. */
function subprojectCount(summary: OrchestratorSummary): number {
  return summary.subprojects.reduce((total, sub) => total + 1 + subprojectCount(sub), 0);
}

/** "1 sub", "3 subs": the hint a folded project card keeps, null without subprojects. */
export function subprojectCountLabel(summary: OrchestratorSummary): string | null {
  const count = subprojectCount(summary);
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
