import type { ProjectIssue } from "@t3tools/contracts";

import type { TaskStatus } from "./projectRequests.logic";

/** Board lanes: the four task statuses, the same words as Roadmap and Needs you. */
export const PROJECT_ISSUE_LANES = [
  { lane: "for-review", title: "For review" },
  { lane: "active", title: "Active" },
  { lane: "pending", title: "Pending" },
  { lane: "complete", title: "Complete" },
] as const satisfies ReadonlyArray<{ lane: TaskStatus; title: string }>;

export type ProjectIssueLane = TaskStatus;

export interface ProjectIssueLanes {
  readonly lanes: Record<ProjectIssueLane, ProjectIssue[]>;
  /** Pending issues set aside for later (Backlog, or the roadmap's Later); folded under Pending. */
  readonly backlog: ProjectIssue[];
}

/**
 * Sorts issues into status lanes (see taskStatuses). Open lanes put the
 * longest-waiting task first; Complete shows the most recently closed first;
 * archived (abandoned) work is left out.
 */
export function groupProjectIssues(
  issues: ReadonlyArray<ProjectIssue>,
  statuses: ReadonlyMap<string, TaskStatus> = new Map(),
): ProjectIssueLanes {
  const lanes: ProjectIssueLanes["lanes"] = {
    "for-review": [],
    active: [],
    pending: [],
    complete: [],
  };
  const backlog: ProjectIssue[] = [];
  for (const issue of issues) {
    if (issue.status === "archived") continue;
    const status =
      statuses.get(`${issue.repository}#${issue.number}`) ??
      (issue.closedAt !== null || issue.status === "done"
        ? "complete"
        : issue.status === "in-progress"
          ? "active"
          : "pending");
    const later =
      issue.status === "backlog" || issue.labels.some((label) => label.toLowerCase() === "parked");
    if (status === "pending" && later) backlog.push(issue);
    else lanes[status].push(issue);
  }
  const oldestFirst = (a: ProjectIssue, b: ProjectIssue) => a.updatedAt.localeCompare(b.updatedAt);
  lanes["for-review"].sort(oldestFirst);
  lanes.active.sort(oldestFirst);
  lanes.pending.sort(oldestFirst);
  backlog.sort(oldestFirst);
  lanes.complete.sort((a, b) =>
    (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt),
  );
  return { lanes, backlog };
}

/** Compact age such as `3d`, `5h`, `12m`. */
export function formatIssueAge(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (!Number.isFinite(minutes)) return "";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}
