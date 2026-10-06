import { isThreadWorking } from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue, ProjectPendingRequest, ProjectRequestStage } from "@t3tools/contracts";

/** Task types, from the `ask:<kind>` label requests and typed issues carry. */
export type RequestKind =
  | "bug"
  | "feature"
  | "question"
  | "deliverable"
  | "plan"
  | "change"
  | "test"
  | "maintenance";

/** What Brad does next with a request that is his to act on. */
export type ForYouGroup = "answers" | "review" | "approve" | "test";

export const FOR_YOU_GROUPS: ReadonlyArray<{ group: ForYouGroup; title: string }> = [
  { group: "answers", title: "Answers ready" },
  { group: "review", title: "Review" },
  { group: "approve", title: "Approve" },
  { group: "test", title: "Test" },
];

export interface ProjectRequest {
  readonly issue: ProjectIssue;
  readonly kind: RequestKind;
  readonly stage: ProjectRequestStage;
  /** Worker threads linked to this request (its orchestrator excluded): who is on it. */
  readonly servedBy: ReadonlyArray<EnvironmentThreadShell>;
  /** The one-line test step posted when the request shipped. */
  readonly testStep: string | null;
  /** Brad owns the next action: the agent marked it ready, or the thread replied since he asked. */
  readonly forYou: ForYouGroup | null;
  /** The thread answered after the request without the agent marking the issue ready. */
  readonly replied: boolean;
  /** Open, not ready, and nothing has moved for a day while its thread sits idle. */
  readonly leftBehind: boolean;
  readonly thread: EnvironmentThreadShell | null;
}

const LEFT_BEHIND_MS = 24 * 60 * 60 * 1000;
const KINDS: ReadonlyArray<RequestKind> = [
  "bug",
  "feature",
  "question",
  "deliverable",
  "plan",
  "change",
  "test",
  "maintenance",
];

/** An issue's task type, or null when it carries no `ask:<kind>` label. */
export function taskKind(labels: ReadonlyArray<string>): RequestKind | null {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  return KINDS.find((kind) => names.has(`ask:${kind}`)) ?? null;
}

export function requestKind(labels: ReadonlyArray<string>): RequestKind {
  return taskKind(labels) ?? "deliverable";
}

/** The issue belongs to this project tree: asked in it, or linked to one of its threads. */
function inTree(issue: ProjectIssue, treeThreadIds: ReadonlySet<string>): boolean {
  const sourceId = issue.requestSource?.threadId;
  return (
    (sourceId !== undefined && treeThreadIds.has(sourceId)) ||
    (issue.requestSource !== null && treeThreadIds.has(issue.requestSource.rootThreadId)) ||
    issue.linkedThreadIds.some((id) => treeThreadIds.has(id))
  );
}

function groupForKind(kind: RequestKind): ForYouGroup {
  switch (kind) {
    case "question":
      return "answers";
    case "plan":
      return "approve";
    case "test":
      return "test";
    default:
      return "review";
  }
}

function repliedSince(thread: EnvironmentThreadShell | null, since: string): boolean {
  if (!thread || isThreadWorking(thread)) return false;
  const completedAt =
    thread.latestRun?.status === "completed" ? thread.latestRun.completedAt : null;
  return completedAt !== null && completedAt !== undefined && completedAt > since;
}

/**
 * The project's open requests with who acts next. Settling is only Brad's action,
 * so a request stays listed until he settles it, however done the work looks.
 */
export function deriveProjectRequests(
  issues: ReadonlyArray<ProjectIssue>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  treeThreadIds: ReadonlySet<string>,
  now: number,
  rootThreadId?: string,
): ProjectRequest[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const requests: ProjectRequest[] = [];
  for (const issue of issues) {
    if (!issue.isRequest || issue.closedAt !== null || issue.status === "done") continue;
    if (issue.status === "archived") continue;
    if (!inTree(issue, treeThreadIds)) continue;
    const sourceId = issue.requestSource?.threadId;
    const thread = (sourceId ? byId.get(sourceId as EnvironmentThreadShell["id"]) : null) ?? null;
    const kind = requestKind(issue.labels);
    const stage = issue.stage ?? "requested";
    // Saved for later: it waits on the roadmap, not in Brad's request list.
    if (stage === "requested" && isParked(issue)) continue;
    const withAgents = stage === "requested" || stage === "in-progress";
    // A reply after the request counts as an answer only while nobody has picked it
    // up; the orchestrator's own replies usually mean "on it", so from it only a
    // question counts as answered.
    const replied =
      stage === "requested" &&
      (thread?.id !== rootThreadId || kind === "question") &&
      repliedSince(thread, issue.createdAt);
    const forYou: ForYouGroup | null =
      stage === "needs-test" ? "test" : stage === "ready" || replied ? groupForKind(kind) : null;
    const leftBehind =
      withAgents &&
      forYou === null &&
      now - Date.parse(issue.updatedAt) > LEFT_BEHIND_MS &&
      (thread === null || !isThreadWorking(thread));
    const servedBy = issue.linkedThreadIds
      .filter((id) => id !== rootThreadId)
      .flatMap((id) => {
        const worker = byId.get(id as EnvironmentThreadShell["id"]);
        return worker ? [worker] : [];
      });
    requests.push({
      issue,
      kind,
      stage,
      servedBy,
      testStep: stage === "needs-test" ? testStepOf(issue) : null,
      forYou,
      replied,
      leftBehind,
      thread,
    });
  }
  return requests.toSorted((a, b) => a.issue.createdAt.localeCompare(b.issue.createdAt));
}

/** The test step an agent posted with `request shipped` ("Test: ..."), if it is the latest comment. */
function testStepOf(issue: ProjectIssue): string | null {
  const body = issue.latestComment?.body.trim() ?? "";
  const match = /^test:\s*(.+)/is.exec(body);
  return match ? match[1]!.split("\n")[0]!.trim() : null;
}

/** Which requests each worker thread serves, for the Working, Blocked and Done rows. */
export function requestsByWorker(
  requests: ReadonlyArray<ProjectRequest>,
): ReadonlyMap<string, ReadonlyArray<ProjectRequest>> {
  const map = new Map<string, ProjectRequest[]>();
  for (const request of requests) {
    for (const worker of request.servedBy) {
      map.set(worker.id, [...(map.get(worker.id) ?? []), request]);
    }
  }
  return map;
}

/** Built and handed over, waiting for the next release batch: derived from stages. */
export const nextReleaseRequests = (requests: ReadonlyArray<ProjectRequest>) =>
  requests.filter((request) => request.stage === "awaiting-release");

export interface CompletedTask {
  readonly issue: ProjectIssue;
  readonly kind: RequestKind | null;
  /** Shipped and waiting for Brad's test; the open request to settle. */
  readonly toTest: ProjectRequest | null;
}

export interface ReleaseGroup {
  /** The milestone that shipped the tasks; null for work done outside a release. */
  readonly release: string | null;
  readonly items: ReadonlyArray<CompletedTask>;
}

/**
 * Completed tasks by the release that shipped them, newest release first: shipped
 * requests waiting for Brad's test, then settled or closed tasks of this project
 * (asked in or linked to its tree, or in a release milestone). Work completed
 * without a release comes last.
 */
export function deriveCompleted(
  issues: ReadonlyArray<ProjectIssue>,
  requests: ReadonlyArray<ProjectRequest>,
  treeThreadIds: ReadonlySet<string>,
): ReleaseGroup[] {
  const byRelease = new Map<string | null, CompletedTask[]>();
  const add = (task: CompletedTask) => {
    const release = task.issue.milestone?.title ?? null;
    byRelease.set(release, [...(byRelease.get(release) ?? []), task]);
  };
  for (const request of requests) {
    if (request.stage === "needs-test")
      add({ issue: request.issue, kind: request.kind, toTest: request });
  }
  for (const issue of issues) {
    if (issue.status === "archived") continue;
    if (issue.closedAt === null && issue.status !== "done") continue;
    if (!inTree(issue, treeThreadIds) && !issue.milestone) continue;
    add({
      issue,
      kind: issue.isRequest ? requestKind(issue.labels) : taskKind(issue.labels),
      toTest: null,
    });
  }
  return [...byRelease]
    .map(([release, items]) => ({
      release,
      items: items.toSorted(
        (a, b) =>
          Number(b.toTest !== null) - Number(a.toTest !== null) ||
          (b.issue.closedAt ?? "").localeCompare(a.issue.closedAt ?? ""),
      ),
    }))
    .toSorted((a, b) =>
      a.release === null
        ? 1
        : b.release === null
          ? -1
          : b.release.localeCompare(a.release, undefined, { numeric: true }),
    );
}

export interface MaintenanceTask {
  readonly issue: ProjectIssue;
  readonly stage: ProjectRequestStage | null;
  readonly request: ProjectRequest | null;
}

/**
 * Open maintenance tasks that do not need Brad: requests typed maintenance still
 * with the agents, and open tracker issues typed `ask:maintenance`.
 */
export function deriveMaintenance(
  issues: ReadonlyArray<ProjectIssue>,
  requests: ReadonlyArray<ProjectRequest>,
): MaintenanceTask[] {
  const tasks: MaintenanceTask[] = requests
    .filter((request) => isMaintenanceWithAgents(request))
    .map((request) => ({ issue: request.issue, stage: request.stage, request }));
  for (const issue of issues) {
    if (issue.isRequest || issue.closedAt !== null) continue;
    if (issue.status === "done" || issue.status === "archived") continue;
    if (taskKind(issue.labels) === "maintenance") tasks.push({ issue, stage: null, request: null });
  }
  return tasks;
}

/** Maintenance requests nobody needs Brad for leave the Requests list for Maintenance. */
export const isMaintenanceWithAgents = (request: ProjectRequest) =>
  request.kind === "maintenance" && request.forYou === null && request.stage !== "awaiting-release";

/** First line of a comment, without its "Progress:" or "Test:" prefix and markdown. */
export function latestProgressLine(body: string | null | undefined): string | null {
  const line = (body ?? "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (!line) return null;
  return line
    .replace(/^(progress|test):\s*/i, "")
    .replace(/\*\*|__|`/g, "")
    .slice(0, 160);
}

const isParked = (issue: Pick<ProjectIssue, "labels">) =>
  issue.labels.some((label) => label.toLowerCase() === "parked");

/** Open requests saved for later in this project, shown as a count under Requests. */
export function countParked(issues: ReadonlyArray<ProjectIssue>, rootThreadId: string): number {
  return issues.filter(
    (issue) =>
      issue.isRequest &&
      issue.closedAt === null &&
      (issue.stage ?? "requested") === "requested" &&
      isParked(issue) &&
      (issue.requestSource?.rootThreadId === rootThreadId ||
        issue.linkedThreadIds.some((id) => id === rootThreadId)),
  ).length;
}

export type SentRequestStatus =
  | { readonly state: "filing" }
  | { readonly state: "pending" }
  | { readonly state: "tracked"; readonly issues: ReadonlyArray<ProjectIssue> };

/**
 * What became of a message sent from the request box: the requests the ledger
 * filed for it (matched by the message id in their provenance), queued for
 * filing while Gitea is unreachable, or not filed yet.
 */
export function sentRequestStatus(
  messageId: string,
  issues: ReadonlyArray<ProjectIssue>,
  pending: ReadonlyArray<Pick<ProjectPendingRequest, "messageId">>,
): SentRequestStatus {
  const filed = issues.filter((issue) => issue.requestSource?.messageId === messageId);
  if (filed.length > 0) return { state: "tracked", issues: filed };
  return pending.some((item) => item.messageId === messageId)
    ? { state: "pending" }
    : { state: "filing" };
}
