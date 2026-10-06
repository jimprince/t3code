import type { ProjectIssue } from "@t3tools/contracts";

/**
 * Board lanes. Needs you and Shipped, test it come from the same source as the
 * Dashboard's Needs you; the rest follow the issue's status.
 */
export const PROJECT_ISSUE_LANES = [
  { lane: "needs-you", title: "Needs you" },
  { lane: "shipped", title: "Shipped, test it" },
  { lane: "in-progress", title: "Working" },
  { lane: "pending", title: "Pending" },
  { lane: "done", title: "Done" },
] as const;

export type ProjectIssueLane = (typeof PROJECT_ISSUE_LANES)[number]["lane"];

export interface ProjectIssueLanes {
  readonly lanes: Record<ProjectIssueLane, ProjectIssue[]>;
  /** Open issues parked in Backlog; shown folded under Pending. */
  readonly backlog: ProjectIssue[];
}

/** The Needs you groups that land in the Shipped, test it lane. */
const SHIPPED_GROUP = "test";

/**
 * Sorts issues into lanes. `needsYou` maps an issue (repository#number) to its
 * Needs you group, so the board and the Dashboard agree. Open lanes put the
 * longest-waiting issue first; Done shows the most recently closed first and
 * skips archived (abandoned) work.
 */
export function groupProjectIssues(
  issues: ReadonlyArray<ProjectIssue>,
  needsYou: ReadonlyMap<string, string> = new Map(),
): ProjectIssueLanes {
  const lanes: ProjectIssueLanes["lanes"] = {
    "needs-you": [],
    shipped: [],
    "in-progress": [],
    pending: [],
    done: [],
  };
  const backlog: ProjectIssue[] = [];
  for (const issue of issues) {
    if (issue.status === "archived") continue;
    const group =
      issue.closedAt === null ? needsYou.get(`${issue.repository}#${issue.number}`) : undefined;
    if (group !== undefined) lanes[group === SHIPPED_GROUP ? "shipped" : "needs-you"].push(issue);
    else if (issue.status === "done") lanes.done.push(issue);
    else if (issue.status === "backlog") backlog.push(issue);
    // Marked for review but not (or no longer) waiting on Brad: still being worked.
    else if (issue.status === "needs-review") lanes["in-progress"].push(issue);
    else lanes[issue.status].push(issue);
  }
  const oldestFirst = (a: ProjectIssue, b: ProjectIssue) => a.updatedAt.localeCompare(b.updatedAt);
  lanes["needs-you"].sort(oldestFirst);
  lanes.shipped.sort(oldestFirst);
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
