import type { ProjectIssue } from "@t3tools/contracts";

/** The open `needs-brad` decisions of a project's issues, longest-waiting first. */
export function deriveDecisions(issues: ReadonlyArray<ProjectIssue>): ProjectIssue[] {
  return issues
    .filter((issue) => issue.decision !== undefined && issue.closedAt === null)
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}
