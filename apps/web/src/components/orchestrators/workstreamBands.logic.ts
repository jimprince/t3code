import {
  isThreadWorking,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";

import { epicPhase, formatEpicProgress } from "./projectHorizon.logic";
import { groupProjectIssues } from "./projectIssuesBoard.logic";
import type { BlockedRow } from "./projectWork.logic";
import { issueKey, type TaskStatus } from "./projectRequests.logic";

/** Row order inside a band: what waits on Brad first, finished work last. */
const BAND_STATUS_ORDER: ReadonlyArray<TaskStatus> = [
  "for-review",
  "active",
  "pending",
  "complete",
];

/** One thread working on, or recently on, a task. */
export interface BandAgent {
  readonly threadId: string;
  readonly title: string;
  readonly working: boolean;
}

export interface BandRow {
  readonly issue: ProjectIssue;
  readonly status: TaskStatus;
  readonly agents: ReadonlyArray<BandAgent>;
  /** What the task's newest linked thread last said, else the issue's newest comment. */
  readonly latest: string | null;
  /** Open same-repository issues it says it is blocked by. */
  readonly blockedBy: ReadonlyArray<number>;
  /** "blocked, stuck 4d": an Active task nobody has touched for days. */
  readonly blockedNote: string | null;
}

/** A workstream: an open epic and the tasks that are part of it, or the tasks that are not. */
export interface Band {
  readonly key: string;
  /** Null for the band of tasks that are part of no epic. */
  readonly epic: ProjectIssue | null;
  /** Everything not complete, in BAND_STATUS_ORDER. */
  readonly rows: ReadonlyArray<BandRow>;
  readonly complete: ReadonlyArray<BandRow>;
  readonly needsYou: number;
  readonly agentsWorking: number;
  readonly blocked: number;
  /** "1 of 4 · Building" for an epic. */
  readonly progress: string | null;
  /** "M1 of M1-M4": the earliest milestone with open tasks; null without milestones. */
  readonly milestone: string | null;
  /** What happened since Brad last looked, or null when nothing did. */
  readonly changes: string | null;
}

const isOpen = (issue: ProjectIssue) =>
  issue.closedAt === null && issue.status !== "done" && issue.status !== "archived";
const isParked = (issue: ProjectIssue) =>
  issue.labels.some((label) => label.toLowerCase() === "parked");

const byTitle = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** "M1 of M1-M4": where the open tasks stand among the milestones they carry. */
export function milestoneLabel(tasks: ReadonlyArray<ProjectIssue>): string | null {
  const titles = [
    ...new Set(tasks.flatMap((task) => (task.milestone ? [task.milestone.title] : []))),
  ].toSorted(byTitle);
  const first = titles[0];
  if (first === undefined) return null;
  const last = titles.at(-1)!;
  return first === last ? first : `${first} of ${first}-${last}`;
}

/**
 * Why tasks and workers count as blocked, from the project's Blocked rows: a task
 * nobody has touched for days reads "blocked, stuck 4d", a blocked or failed worker
 * "blocked: <reason>" or "failed". Tasks that say "Blocked by #N" are in `blockedBy`.
 */
export function blockedNotes(rows: ReadonlyArray<BlockedRow>) {
  const tasks = new Map<string, string>();
  const workers = new Map<string, string>();
  for (const row of rows) {
    const key = row.key.slice(row.key.indexOf(":") + 1);
    if (row.kind === "stuck") tasks.set(key, `blocked, ${row.cause.toLowerCase()}`);
    else if (row.kind === "worker") {
      workers.set(key, row.cause === "Failed" ? "failed" : `blocked: ${row.cause}`);
    }
  }
  return { tasks, workers };
}

/** First line of a message, cut at a word near `max` characters. */
export function firstLine(text: string | null | undefined, max = 140): string | null {
  const line = (text ?? "")
    .split("\n")
    .map((part) => part.replace(/^[#>*\s-]+/, "").trim())
    .find((part) => part.length > 0);
  if (line === undefined) return null;
  if (line.length <= max) return line;
  const cut = line.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(" "), max / 2))}…`;
}

const byUpdatedDesc = (a: OrchestratorThreadShell, b: OrchestratorThreadShell) =>
  b.updatedAt.localeCompare(a.updatedAt);

function rowFor(
  issue: ProjectIssue,
  status: TaskStatus,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
  rootThreadId: string,
  openNumbers: ReadonlySet<string>,
  taskNotes: ReadonlyMap<string, string>,
): BandRow {
  const linked = issue.linkedThreadIds
    .filter((id) => id !== rootThreadId)
    .flatMap((id) => threadsById.get(id) ?? [])
    .filter((thread) => thread.archivedAt === null)
    .toSorted(byUpdatedDesc);
  const agents =
    status === "complete"
      ? []
      : linked.flatMap((thread) => {
          const working = isThreadWorking(thread);
          if (!working && (status !== "active" || thread.settledOverride === "settled")) return [];
          return [{ threadId: thread.id, title: thread.title, working }];
        });
  const said = linked.map((thread) => firstLine(thread.source.workerSummary?.output)).find(Boolean);
  return {
    issue,
    status,
    agents,
    latest: status === "complete" ? null : (said ?? firstLine(issue.latestComment?.body)),
    blockedBy: (issue.blockedBy ?? []).filter((number) =>
      openNumbers.has(issueKey({ repository: issue.repository, number })),
    ),
    blockedNote: taskNotes.get(issueKey(issue)) ?? null,
  };
}

/**
 * Whether a band shows its rows before the user chooses: when it has work that
 * waits on Brad or is under way, or is the only band. The rest start closed.
 */
export const bandOpensByDefault = (band: Band, bandCount: number) =>
  bandCount === 1 || band.needsYou > 0 || band.agentsWorking > 0;

/** Whether `time` is later than `since`; tracker and thread clocks may carry different UTC offsets. */
export const isAfter = (time: string, since: string) => Date.parse(time) > Date.parse(since);

/** "#11 closed · 2 agents started, 1 finished": the band's changes since `since`, the orchestrator excluded. */
function describeChanges(
  members: ReadonlyArray<ProjectIssue>,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
  since: string,
  rootThreadId: string,
): string | null {
  const closed = members.filter(
    (issue) => issue.closedAt !== null && isAfter(issue.closedAt, since),
  );
  const threadIds = new Set(members.flatMap((issue) => issue.linkedThreadIds));
  const threads = [...threadIds]
    .filter((id) => id !== rootThreadId)
    .flatMap((id) => threadsById.get(id) ?? [])
    .filter((thread) => thread.archivedAt === null);
  const started = threads.filter((thread) => isAfter(thread.createdAt, since)).length;
  const finished = threads.filter(
    (thread) =>
      !isThreadWorking(thread) &&
      thread.latestRun?.completedAt != null &&
      isAfter(thread.latestRun.completedAt, since),
  ).length;
  const parts = [
    closed.length > 0
      ? closed.length <= 2
        ? `${closed.map((issue) => `#${issue.number}`).join(", ")} closed`
        : `${closed.length} closed`
      : null,
    started > 0 ? `${started} ${started === 1 ? "agent" : "agents"} started` : null,
    finished > 0 ? `${finished} finished` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The project's tasks grouped by workstream, attention first (A2): bands that
 * wait on Brad, then bands with agents working, then the rest by epic number.
 * An open epic is a band of its "Part of" children and its checklist's open ones;
 * every other task falls in one band with a null epic, listed last. Archived tasks
 * are left out; a parked or closed epic is a row of that last band.
 */
export function deriveBands(input: {
  readonly issues: ReadonlyArray<ProjectIssue>;
  readonly statuses: ReadonlyMap<string, TaskStatus>;
  readonly threadsById: ReadonlyMap<string, OrchestratorThreadShell>;
  readonly rootThreadId: string;
  /** Brad's previous visit; no changes line without it. */
  readonly since?: string | null;
  /** See blockedNotes. */
  readonly taskNotes?: ReadonlyMap<string, string>;
}): Band[] {
  const { issues, statuses, threadsById, rootThreadId } = input;
  const grouped = groupProjectIssues(issues, statuses);
  const statusByKey = new Map<string, TaskStatus>();
  for (const status of BAND_STATUS_ORDER) {
    for (const issue of grouped.lanes[status]) statusByKey.set(issueKey(issue), status);
  }
  for (const issue of grouped.backlog) statusByKey.set(issueKey(issue), "pending");
  const openNumbers = new Set(issues.filter(isOpen).map(issueKey));
  const epics = issues
    .filter((issue) => issue.epic !== undefined && isOpen(issue) && !isParked(issue))
    .toSorted((a, b) => a.number - b.number);
  const taken = new Set<string>();

  const build = (key: string, epic: ProjectIssue | null, members: ProjectIssue[]): Band => {
    const rows = members
      .filter((issue) => statusByKey.has(issueKey(issue)))
      .map((issue) =>
        rowFor(
          issue,
          statusByKey.get(issueKey(issue))!,
          threadsById,
          rootThreadId,
          openNumbers,
          input.taskNotes ?? new Map(),
        ),
      );
    const rank = (row: BandRow) => BAND_STATUS_ORDER.indexOf(row.status);
    const open = rows
      .filter((row) => row.status !== "complete")
      .toSorted((a, b) => rank(a) - rank(b) || a.issue.updatedAt.localeCompare(b.issue.updatedAt));
    const complete = rows
      .filter((row) => row.status === "complete")
      .toSorted((a, b) =>
        (b.issue.closedAt ?? b.issue.updatedAt).localeCompare(
          a.issue.closedAt ?? a.issue.updatedAt,
        ),
      );
    return {
      key,
      epic,
      rows: open,
      complete,
      needsYou: open.filter((row) => row.status === "for-review").length,
      agentsWorking: new Set([
        ...open.flatMap((row) =>
          row.agents.filter((agent) => agent.working).map((a) => a.threadId),
        ),
        ...(epic?.linkedThreadIds ?? []).filter((id) => {
          const thread = threadsById.get(id);
          return (
            id !== rootThreadId &&
            thread !== undefined &&
            thread.archivedAt === null &&
            isThreadWorking(thread)
          );
        }),
      ]).size,
      blocked: open.filter((row) => row.blockedBy.length > 0 || row.blockedNote !== null).length,
      progress: epic?.epic
        ? formatEpicProgress(
            epic.epic,
            epicPhase(
              epic.epic,
              (number) => statusByKey.get(`${epic.repository}#${number}`) ?? "pending",
            ),
          )
        : null,
      milestone: milestoneLabel(open.map((row) => row.issue)),
      changes:
        input.since == null
          ? null
          : describeChanges(
              epic ? [epic, ...members] : members,
              threadsById,
              input.since,
              rootThreadId,
            ),
    };
  };

  // An epic's tasks are those that say "Part of" it and those its checklist still lists.
  const bands = epics.map((epic) => {
    const listed = new Set(epic.epic?.remaining ?? []);
    const members = issues.filter(
      (issue) =>
        issue.repository === epic.repository &&
        issue !== epic &&
        !taken.has(issueKey(issue)) &&
        (issue.partOf === epic.number || listed.has(issue.number)),
    );
    for (const issue of members) taken.add(issueKey(issue));
    return build(issueKey(epic), epic, members);
  });
  const attention = (band: Band) => (band.needsYou > 0 ? 0 : band.agentsWorking > 0 ? 1 : 2);
  bands.sort((a, b) => attention(a) - attention(b));
  // An epic with a band is a workstream, not a row; a parked or closed one lists as a task.
  const banded = new Set(epics.map(issueKey));
  const others = issues.filter(
    (issue) => !taken.has(issueKey(issue)) && !banded.has(issueKey(issue)),
  );
  const rest = build("other", null, others);
  return rest.rows.length + rest.complete.length > 0 ? [...bands, rest] : bands;
}
