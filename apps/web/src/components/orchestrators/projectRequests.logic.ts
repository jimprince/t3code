import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectIssue } from "@t3tools/contracts";

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
  return threadRuntimeIsActive(thread.runtime) || thread.pendingBackgroundTasks.length > 0;
}

function repliedSince(thread: EnvironmentThreadShell | null, since: string): boolean {
  if (!thread || isWorking(thread)) return false;
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
    const ready = issue.status === "needs-review";
    const replied = !ready && repliedSince(thread, issue.createdAt);
    const forYou = ready || replied ? groupForKind(kind) : null;
    const leftBehind =
      forYou === null &&
      now - Date.parse(issue.updatedAt) > LEFT_BEHIND_MS &&
      (thread === null || !isWorking(thread));
    requests.push({ issue, kind, forYou, replied, leftBehind, thread });
  }
  return requests.toSorted((a, b) => a.issue.createdAt.localeCompare(b.issue.createdAt));
}
