import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
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
  { group: "test", title: "Shipped, test it" },
];

export interface ProjectRequest {
  readonly issue: ProjectIssue;
  readonly kind: RequestKind;
  readonly stage: ProjectRequestStage;
  /** Worker threads linked to this request (its orchestrator excluded): who is on it. */
  readonly servedBy: ReadonlyArray<EnvironmentThreadShell>;
  /** The one-line test step posted when the request shipped. */
  readonly testStep: string | null;
  /** Brad owns the next action: the agent marked it ready, or the thread answered this request. */
  readonly forYou: ForYouGroup | null;
  /** The thread answered this request's message without the agent marking the issue ready. */
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

function isWorking(thread: EnvironmentThreadShell): boolean {
  return threadRuntimeIsActive(thread.runtime) || thread.pendingBackgroundTasks.length > 0;
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
  /** Also list requests saved for later (the layout's Include Later setting). */
  includeLater = false,
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
    if (stage === "requested" && isParked(issue) && !includeLater) continue;
    const withAgents = stage === "requested" || stage === "in-progress";
    // A reply after the request counts as an answer only while nobody has picked it
    // up; the orchestrator's own replies usually mean "on it", so from it only a
    // question counts as answered.
    // Answered when the server found the thread's reply to this request's own
    // message: stored data, so the request never flips between groups as the
    // thread starts and finishes other turns.
    const replied =
      stage === "requested" &&
      (thread?.id !== rootThreadId || kind === "question") &&
      issue.answer !== undefined;
    const forYou: ForYouGroup | null =
      stage === "needs-test" ? "test" : stage === "ready" || replied ? groupForKind(kind) : null;
    const leftBehind =
      withAgents &&
      forYou === null &&
      now - Date.parse(issue.updatedAt) > LEFT_BEHIND_MS &&
      (thread === null || !isWorking(thread));
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
  includeLater = false,
): MaintenanceTask[] {
  const tasks: MaintenanceTask[] = requests
    .filter((request) => isMaintenanceWithAgents(request))
    .map((request) => ({ issue: request.issue, stage: request.stage, request }));
  for (const issue of issues) {
    if (issue.isRequest || issue.closedAt !== null || (isParked(issue) && !includeLater)) continue;
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

/** Issue identity across repositories, for the Needs you lane and rows. */
export const issueKey = (issue: Pick<ProjectIssue, "repository" | "number">) =>
  `${issue.repository}#${issue.number}`;

export interface NeedsYouItem {
  readonly issue: ProjectIssue;
  /** The request behind it, when Brad asked for it. */
  readonly request: ProjectRequest | null;
  readonly group: ForYouGroup;
}

/**
 * Everything on the tracker waiting on Brad, from one source for the Dashboard's
 * Needs you and the Issues board's Needs you lane: requests in his groups, and
 * any other open issue marked for review or shipped for him to test. Parked
 * (Later) items stay off.
 */
export function deriveNeedsYou(
  issues: ReadonlyArray<ProjectIssue>,
  requests: ReadonlyArray<ProjectRequest>,
): NeedsYouItem[] {
  const items: NeedsYouItem[] = requests.flatMap((request) =>
    request.forYou === null ? [] : [{ issue: request.issue, request, group: request.forYou }],
  );
  const seen = new Set(items.map((item) => issueKey(item.issue)));
  for (const issue of issues) {
    if (issue.isRequest || seen.has(issueKey(issue)) || issue.closedAt !== null) continue;
    if (isParked(issue)) continue;
    const labels = new Set(issue.labels.map((label) => label.toLowerCase()));
    if (labels.has("needs-test")) items.push({ issue, request: null, group: "test" });
    else if (issue.status === "needs-review") items.push({ issue, request: null, group: "review" });
  }
  return items;
}

/**
 * Open requests whose thread Brad already settled: the work there is over, so
 * the page offers to settle them together instead of one by one.
 */
export function requestsOfSettledThreads(
  requests: ReadonlyArray<ProjectRequest>,
): Array<{ readonly thread: EnvironmentThreadShell; readonly requests: ProjectRequest[] }> {
  const byThread = new Map<
    string,
    { thread: EnvironmentThreadShell; requests: ProjectRequest[] }
  >();
  for (const request of requests) {
    const thread = request.thread;
    if (!thread?.settledAt) continue;
    const group = byThread.get(thread.id) ?? { thread, requests: [] };
    group.requests.push(request);
    byThread.set(thread.id, group);
  }
  return [...byThread.values()];
}

/**
 * An answer shown under its question: the first one to three sentences of the
 * reply, whole (never cut mid-sentence), without markdown markers.
 */
export function answerSentences(text: string, limit = 3): string {
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`|^#+\s*|^>\s*|^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [plain];
  return sentences
    .slice(0, limit)
    .map((sentence) => sentence.trim())
    .join(" ");
}

/** The one status vocabulary of the project page: Tasks, Roadmap and Needs you share it. */
export type TaskStatus = "for-review" | "active" | "pending" | "complete";

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  "for-review": "For review",
  active: "Active",
  pending: "Pending",
  complete: "Complete",
};

/**
 * Every task's status, from the same sources everywhere: Complete when closed;
 * For review when it waits on Brad (deriveNeedsYou, shipped work to test
 * included); Active when it is marked in progress or a worker thread linked to
 * it is working (the orchestrator alone does not count); Pending otherwise.
 */
export function taskStatuses(
  issues: ReadonlyArray<ProjectIssue>,
  needsYou: ReadonlyArray<NeedsYouItem>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
  rootThreadId: string,
): Map<string, TaskStatus> {
  const forReview = new Set(needsYou.map((item) => issueKey(item.issue)));
  const working = new Set(
    threads.filter((thread) => thread.id !== rootThreadId && isWorking(thread)).map((t) => t.id),
  );
  const statuses = new Map<string, TaskStatus>();
  for (const issue of issues) {
    const key = issueKey(issue);
    statuses.set(
      key,
      issue.closedAt !== null || issue.status === "done"
        ? "complete"
        : forReview.has(key)
          ? "for-review"
          : issue.status === "in-progress" || issue.linkedThreadIds.some((id) => working.has(id))
            ? "active"
            : "pending",
    );
  }
  return statuses;
}

/** A request's status from its stage, for rows that have no issue list at hand. */
export const STAGE_STATUS: Record<ProjectRequestStage, TaskStatus> = {
  requested: "pending",
  "in-progress": "active",
  // Built and handed over: still being shipped, not Brad's yet.
  "awaiting-release": "active",
  ready: "for-review",
  "needs-test": "for-review",
  settled: "complete",
};

export interface StatusCounts {
  readonly total: number;
  readonly complete: number;
  readonly active: number;
  readonly forReview: number;
  readonly pending: number;
}

/** "63 · 12 complete · 3 active · 2 for review · 46 pending" for a set of tasks. */
export function countStatuses(
  statuses: ReadonlyArray<TaskStatus>,
  extraComplete = 0,
): StatusCounts {
  const count = (status: TaskStatus) => statuses.filter((value) => value === status).length;
  const complete = count("complete") + extraComplete;
  return {
    total: statuses.length + extraComplete,
    complete,
    active: count("active"),
    forReview: count("for-review"),
    pending: count("pending"),
  };
}

export const formatStatusCounts = (counts: StatusCounts) =>
  [
    `${counts.total}`,
    `${counts.complete} complete`,
    `${counts.active} active`,
    `${counts.forReview} for review`,
    `${counts.pending} pending`,
  ].join(" · ");

export interface DecisionOption {
  /** "Option A": the button's label. */
  readonly label: string;
  readonly text: string;
}

/** A Needs you row that asks Brad to choose or approve, with what the buttons need. */
export interface NeedsYouDecision {
  /** One or two whole sentences of what the agent asks. */
  readonly summary: string;
  readonly recommendation: string | null;
  /** The choices a ready comment lists, at least two; empty when it is a plain approval. */
  readonly options: ReadonlyArray<DecisionOption>;
}

const OPTION_LINE =
  /^(?:[-*]\s+)?(?:[Oo]ption\s+([A-Za-z]|\d{1,2})\s*[:.)–—-]|\(?([A-Z])[:)])\s*(.+)$/;
const RECOMMENDATION_LINE =
  /^(?:[-*]\s+)?(?:(?:my|our)\s+recommendation|recommendation|recommended|i\s+recommend|we\s+recommend)\b\s*[:-]?\s*(.+)$/i;

/**
 * What a ready comment asks of Brad: the choices it lists as lines starting
 * "Option A:" or "A)" (two or more, else they are not choices), its recommendation
 * line, and the rest as the summary.
 */
export function parseDecisionComment(body: string): NeedsYouDecision {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.replace(/\*\*|__|`/g, "").trim())
    .filter((line) => line.length > 0);
  const options: DecisionOption[] = [];
  let recommendation: string | null = null;
  const rest: string[] = [];
  for (const line of lines) {
    const option = OPTION_LINE.exec(line);
    if (option) {
      options.push({
        label: `Option ${(option[1] ?? option[2]!).toUpperCase()}`,
        text: option[3]!.trim().slice(0, 200),
      });
      continue;
    }
    const recommended = RECOMMENDATION_LINE.exec(line);
    if (recommended && recommendation === null) {
      recommendation = recommended[1]!.trim();
      continue;
    }
    rest.push(line);
  }
  const named = new Set(options.map((option) => option.label));
  const choices = options.length >= 2 && named.size === options.length ? options : [];
  return {
    summary: answerSentences(rest.join(" ").replace(/^\s*(progress|test):\s*/i, ""), 2),
    recommendation,
    options: choices,
  };
}

const isEpic = (labels: ReadonlyArray<string>) =>
  labels.some((label) => label.toLowerCase() === "ask:epic");

/**
 * The decision a Needs you item asks of Brad, or null when it does not: an epic or
 * plan its agent marked ready (Approve, Not yet), or a ready comment listing options
 * (a button per option). Answers and shipped work to test are other row kinds.
 */
export function needsYouDecision(item: NeedsYouItem): NeedsYouDecision | null {
  if (item.group === "answers" || item.group === "test") return null;
  if (item.request !== null && item.request.stage !== "ready") return null;
  const parsed = parseDecisionComment(item.issue.latestComment?.body ?? "");
  if (parsed.options.length === 0 && item.group !== "approve" && !isEpic(item.issue.labels))
    return null;
  return parsed;
}
