import type { ProjectIssue } from "@t3tools/contracts";

import { epicPhase, formatEpicProgress, type EpicPhase } from "./projectHorizon.logic";
import { issueKey, type TaskStatus } from "./projectRequests.logic";
import type { BlockedRow } from "./projectWork.logic";

/** One line of the Dashboard's Workstreams block: an epic that still has work left. */
export interface Workstream {
  readonly epic: ProjectIssue;
  readonly phase: EpicPhase;
  /** "1 of 4 · Building". */
  readonly progress: string;
  /** "M1 of M1-M4": the earliest milestone with open children, in the children's order; null without milestones. */
  readonly milestone: string | null;
  /** Worker threads working now on the epic or one of its open children. */
  readonly agents: number;
  /** The first Active child, else the first Pending one. */
  readonly next: { readonly title: string; readonly status: TaskStatus } | null;
  readonly blocked: boolean;
}

const isOpen = (issue: ProjectIssue) =>
  issue.closedAt === null && issue.status !== "done" && issue.status !== "archived";
const isParked = (issue: ProjectIssue) =>
  issue.labels.some((label) => label.toLowerCase() === "parked");

const byNumber = (a: ProjectIssue, b: ProjectIssue) => a.number - b.number;
const byTitle = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** "M1 of M1-M4": where the open children stand among the milestones they carry. */
export function milestoneLabel(children: ReadonlyArray<ProjectIssue>): string | null {
  const titles = [
    ...new Set(children.flatMap((child) => (child.milestone ? [child.milestone.title] : []))),
  ].toSorted(byTitle);
  const first = titles[0];
  if (first === undefined) return null;
  const last = titles.at(-1)!;
  return first === last ? first : `${first} of ${first}-${last}`;
}

/**
 * The project's active epics, each with its open children: an open epic counts
 * until no child is left. Derived only from the issue list, task statuses and
 * the worker threads working now (`workingThreadIds`, the orchestrator excluded).
 */
export function deriveWorkstreams(input: {
  readonly issues: ReadonlyArray<ProjectIssue>;
  readonly statuses: ReadonlyMap<string, TaskStatus>;
  readonly workingThreadIds: ReadonlySet<string>;
  readonly blockedRows: ReadonlyArray<BlockedRow>;
  readonly rootThreadId: string;
}): Workstream[] {
  const { issues, statuses, workingThreadIds, blockedRows, rootThreadId } = input;
  const open = new Map(issues.filter(isOpen).map((issue) => [issueKey(issue), issue]));
  const blockedKeys = new Set(
    blockedRows.flatMap((row) =>
      row.kind === "worker" ? [] : [row.key.slice(row.key.indexOf(":") + 1)],
    ),
  );
  const blockedWorkers = new Set(
    blockedRows.flatMap((row) => (row.kind === "worker" && row.owner ? [row.owner.id] : [])),
  );

  return issues
    .filter(
      (issue) =>
        issue.epic !== undefined &&
        issue.epic.remaining.length > 0 &&
        isOpen(issue) &&
        !isParked(issue),
    )
    .toSorted(byNumber)
    .map((epic) => {
      const progress = epic.epic!;
      const statusOf = (number: number): TaskStatus =>
        statuses.get(issueKey({ repository: epic.repository, number })) ?? "pending";
      const children = progress.remaining
        .flatMap((number) => open.get(issueKey({ repository: epic.repository, number })) ?? [])
        .toSorted(byNumber);
      const members = [epic, ...children];
      const phase = epicPhase(progress, statusOf);
      const next = (["active", "pending"] as const)
        .flatMap((status) =>
          children
            .filter((child) => statusOf(child.number) === status)
            .map((child) => ({ title: child.title, status })),
        )
        .at(0);
      return {
        epic,
        phase,
        progress: formatEpicProgress(progress, phase),
        milestone: milestoneLabel(children),
        agents: new Set(
          members.flatMap((issue) =>
            issue.linkedThreadIds.filter((id) => id !== rootThreadId && workingThreadIds.has(id)),
          ),
        ).size,
        next: next ?? null,
        blocked: members.some(
          (issue) =>
            blockedKeys.has(issueKey(issue)) ||
            (issue !== epic &&
              ((issue.blockedBy ?? []).some((number) =>
                open.has(issueKey({ repository: issue.repository, number })),
              ) ||
                issue.linkedThreadIds.some((id) => blockedWorkers.has(id)))),
        ),
      };
    });
}
