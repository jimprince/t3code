import type { ProjectIssue, ProjectIssueStatus } from "@t3tools/contracts";

/** Lanes in Agent Status Board order and wording, so the two boards read the same. */
export const PROJECT_ISSUE_LANES = [
  { status: "needs-review", title: "Needs your review" },
  { status: "in-progress", title: "In progress" },
  { status: "pending", title: "Pending" },
  { status: "done", title: "Done" },
] as const satisfies ReadonlyArray<{ status: ProjectIssueStatus; title: string }>;

export type ProjectIssueLaneStatus = (typeof PROJECT_ISSUE_LANES)[number]["status"];

export interface ProjectIssueLanes {
  readonly lanes: Record<ProjectIssueLaneStatus, ProjectIssue[]>;
  /** Open issues parked in Backlog; shown folded under Pending. */
  readonly backlog: ProjectIssue[];
}

/**
 * Sorts issues into lanes. Open lanes put the longest-waiting issue first;
 * Done shows the most recently closed first and skips archived (abandoned) work,
 * which the Agent Status Board also keeps out of its lanes.
 */
export function groupProjectIssues(issues: ReadonlyArray<ProjectIssue>): ProjectIssueLanes {
  const lanes: ProjectIssueLanes["lanes"] = {
    "needs-review": [],
    "in-progress": [],
    pending: [],
    done: [],
  };
  const backlog: ProjectIssue[] = [];
  for (const issue of issues) {
    if (issue.status === "archived") continue;
    if (issue.status === "backlog") backlog.push(issue);
    else lanes[issue.status].push(issue);
  }
  const oldestFirst = (a: ProjectIssue, b: ProjectIssue) => a.updatedAt.localeCompare(b.updatedAt);
  lanes["needs-review"].sort(oldestFirst);
  lanes["in-progress"].sort(oldestFirst);
  lanes.pending.sort(oldestFirst);
  backlog.sort(oldestFirst);
  lanes.done.sort((a, b) => (b.closedAt ?? b.updatedAt).localeCompare(a.closedAt ?? a.updatedAt));
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
