import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";

export const projectKeyOf = (summary: OrchestratorSummary) =>
  `${summary.root.environmentId}:${summary.root.id}`;

/** Whether the open page or thread is the project's own (its root or a worker), not a subproject's. */
export const ownTreeContains = (summary: OrchestratorSummary, threadKey: string | null) =>
  threadKey !== null &&
  [summary.root, ...summary.descendants].some(
    (thread) => `${thread.environmentId}:${thread.id}` === threadKey,
  );

/** Open tasks across the project and every subproject beneath it, each linked issue once. */
export function openTaskCount(summary: OrchestratorSummary): number {
  const open = new Set<string>();
  const visit = (project: OrchestratorSummary) => {
    for (const issue of project.issues) {
      if (issue.snapshot?.state !== "closed") {
        open.add(`${issue.host}/${issue.repository}#${issue.number}`);
      }
    }
    project.subprojects.forEach(visit);
  };
  visit(summary);
  return open.size;
}

/** Busy now: its workers or its own orchestrator are active, or it is supervising them. */
export const subprojectIsActive = (summary: OrchestratorSummary) =>
  summary.rollup.working > 0 ||
  summary.status === "working" ||
  summary.status === "monitoring" ||
  summary.status === "supervising";

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
