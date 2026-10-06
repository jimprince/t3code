import type { ProjectIssue, ProjectIssuesGetResult } from "@t3tools/contracts";

import {
  issueKey,
  latestProgressLine,
  STAGE_STATUS,
  taskKind,
  type RequestKind,
  type TaskStatus,
} from "./projectRequests.logic";

export interface TaskRef {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
}

const TASK_REF = /^([^/\s#]+)\/([^/\s#]+\/[^/\s#]+)#(\d+)$/;

/** The `task` search value that opens a task: "host/owner/repo#12". */
export const encodeTaskRef = (ref: TaskRef) => `${ref.host}/${ref.repository}#${ref.number}`;

export function parseTaskRef(value: unknown): TaskRef | null {
  const match = typeof value === "string" ? TASK_REF.exec(value) : null;
  const number = match ? Number(match[3]) : 0;
  return match && number > 0 ? { host: match[1]!, repository: match[2]!, number } : null;
}

export interface TaskViewChild {
  readonly issue: ProjectIssue;
  readonly status: TaskStatus;
}

export interface TaskView {
  readonly issue: ProjectIssue;
  readonly status: TaskStatus;
  readonly kind: RequestKind | null;
  /** The answer or decision, whole; null until there is one. */
  readonly answer: string | null;
  /** The newest agent progress note, while the work is not finished. */
  readonly progress: string | null;
  readonly children: ReadonlyArray<TaskViewChild>;
  /** Worker and source threads of the task, the one that asked first. */
  readonly threadIds: ReadonlyArray<string>;
}

const isProgress = (body: string) => /^\s*progress:/i.test(body);

/** The status from the shared project-page map, or from the issue itself when it is not listed. */
export function taskViewStatus(
  issue: ProjectIssue,
  statuses: ReadonlyMap<string, TaskStatus>,
): TaskStatus {
  const listed = statuses.get(issueKey(issue));
  if (listed) return listed;
  if (issue.closedAt !== null || issue.status === "done") return "complete";
  if (issue.stage) return STAGE_STATUS[issue.stage];
  if (issue.status === "needs-review") return "for-review";
  return issue.status === "in-progress" ? "active" : "pending";
}

/**
 * The answer or decision: the agent's summary comment once the task is for review
 * or complete, otherwise the thread's reply to the message that filed it. A
 * progress note is never the answer.
 */
export function pickAnswer(
  issue: ProjectIssue,
  comments: ReadonlyArray<{ readonly body: string }>,
  status: TaskStatus,
): string | null {
  const summary = comments.findLast((comment) => !isProgress(comment.body) && comment.body.trim());
  const reviewing = status === "for-review" || status === "complete" || !issue.isRequest;
  const text = reviewing ? (summary?.body ?? issue.answer?.text) : (issue.answer?.text ?? null);
  return text?.replace(/<!--[\s\S]*?-->/g, "").trim() || null;
}

export function deriveTaskView(
  result: ProjectIssuesGetResult,
  issues: ReadonlyArray<ProjectIssue>,
  statuses: ReadonlyMap<string, TaskStatus>,
): TaskView {
  const { issue } = result;
  const status = taskViewStatus(issue, statuses);
  const latestProgress = result.comments.findLast((comment) => isProgress(comment.body));
  const children = result.childNumbers.flatMap((number): TaskViewChild[] => {
    const child = issues.find(
      (candidate) => candidate.number === number && candidate.repository === issue.repository,
    );
    return child ? [{ issue: child, status: taskViewStatus(child, statuses) }] : [];
  });
  const threadIds = [
    ...new Set([
      ...(issue.requestSource ? [issue.requestSource.threadId] : []),
      ...issue.linkedThreadIds,
    ]),
  ];
  return {
    issue,
    status,
    kind: taskKind(issue.labels),
    answer: pickAnswer(issue, result.comments, status),
    progress:
      status === "active" || status === "pending"
        ? latestProgressLine(latestProgress?.body ?? null)
        : null,
    children: children.toSorted((a, b) => a.issue.number - b.issue.number),
    threadIds,
  };
}
