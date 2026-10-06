import type { ProjectIssue, ProjectRoadmapItem } from "@t3tools/contracts";

import type { GiteaMilestone } from "../projectIssues/giteaMilestones.ts";

/** Roadmap order: due date first (undated last), then creation order. The first is next. */
export function orderVersions(milestones: ReadonlyArray<GiteaMilestone>): GiteaMilestone[] {
  return milestones
    .filter((milestone) => milestone.id > 0 && milestone.title.trim().length > 0)
    .toSorted((a, b) => {
      const dueA = a.due_on ? Date.parse(a.due_on) : Number.POSITIVE_INFINITY;
      const dueB = b.due_on ? Date.parse(b.due_on) : Number.POSITIVE_INFINITY;
      return dueA === dueB ? a.id - b.id : dueA - dueB;
    });
}

/** The open version with this title, ignoring case and surrounding space. */
export function findVersion(
  milestones: ReadonlyArray<GiteaMilestone>,
  title: string,
): GiteaMilestone | undefined {
  const wanted = title.trim().toLowerCase();
  return milestones.find((milestone) => milestone.title.trim().toLowerCase() === wanted);
}

/**
 * The tracker's open requests and issues, each in its open version or unversioned.
 * An item whose milestone is closed (a shipped release) is not on the roadmap.
 */
export function roadmapItems(
  issues: ReadonlyArray<ProjectIssue>,
  tracker: { readonly host: string; readonly repository: string },
  openMilestones: ReadonlyArray<GiteaMilestone>,
): ProjectRoadmapItem[] {
  const open = new Set(openMilestones.map((milestone) => milestone.id));
  return issues
    .filter(
      (issue) =>
        issue.host === tracker.host &&
        issue.repository === tracker.repository &&
        issue.closedAt === null &&
        issue.status !== "done" &&
        issue.status !== "archived" &&
        (!issue.milestone || open.has(issue.milestone.id)),
    )
    .map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      isRequest: issue.isRequest,
      stage: issue.stage ?? null,
      versionId: issue.milestone?.id ?? null,
      parked: issue.labels.some((label) => label.toLowerCase() === "parked"),
      ...(issue.epic ? { epic: issue.epic } : {}),
    }));
}
