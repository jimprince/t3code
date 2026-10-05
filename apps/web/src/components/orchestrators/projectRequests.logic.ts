import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue, ProjectRequestStage } from "@t3tools/contracts";

export type RequestKind = "question" | "deliverable" | "plan" | "change" | "test";

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
const KINDS: ReadonlyArray<RequestKind> = ["question", "deliverable", "plan", "change", "test"];

export function requestKind(labels: ReadonlyArray<string>): RequestKind {
  const names = new Set(labels.map((label) => label.toLowerCase()));
  return KINDS.find((kind) => names.has(`ask:${kind}`)) ?? "deliverable";
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
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.backgroundLiveness === "working"
  );
}

function repliedSince(thread: EnvironmentThreadShell | null, since: string): boolean {
  if (!thread || isWorking(thread)) return false;
  const completedAt =
    thread.latestTurn?.state === "completed" ? thread.latestTurn.completedAt : null;
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
    const sourceId = issue.requestSource?.threadId;
    const inTree =
      (sourceId !== undefined && treeThreadIds.has(sourceId)) ||
      (issue.requestSource !== null && treeThreadIds.has(issue.requestSource.rootThreadId)) ||
      issue.linkedThreadIds.some((id) => treeThreadIds.has(id));
    if (!inTree) continue;
    const thread = (sourceId ? byId.get(sourceId as EnvironmentThreadShell["id"]) : null) ?? null;
    const kind = requestKind(issue.labels);
    const stage = issue.stage ?? "requested";
    const withAgents = stage === "requested" || stage === "in-progress";
    const replied = withAgents && repliedSince(thread, issue.createdAt);
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

export interface ReleaseView {
  /** Built and handed over, waiting for the next release batch. */
  readonly next: ReadonlyArray<ProjectRequest>;
  /** Shipped and waiting for Brad's test, by release (the request's milestone). */
  readonly shipped: ReadonlyArray<{
    readonly release: string;
    readonly items: ReadonlyArray<ProjectRequest>;
  }>;
}

/** The Release widget, derived from request stages: no second store. */
export function deriveRelease(requests: ReadonlyArray<ProjectRequest>): ReleaseView {
  const next = requests.filter((request) => request.stage === "awaiting-release");
  const byRelease = new Map<string, ProjectRequest[]>();
  for (const request of requests) {
    if (request.stage !== "needs-test") continue;
    const release = request.issue.milestone?.title ?? "Unversioned";
    byRelease.set(release, [...(byRelease.get(release) ?? []), request]);
  }
  return {
    next,
    shipped: [...byRelease]
      .map(([release, items]) => ({ release, items }))
      .toSorted((a, b) => b.release.localeCompare(a.release, undefined, { numeric: true })),
  };
}
