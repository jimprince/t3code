import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

/**
 * Board lanes, derived from Gitea issue state and labels exactly as the Agent
 * Status Board derives them, so the two views agree and can merge later:
 * closed -> done (or archived with the `archived` label); open + `needs-review`,
 * `in-progress` or `backlog` -> that lane; any other open issue -> pending.
 */
export const ProjectIssueStatus = Schema.Literals([
  "needs-review",
  "in-progress",
  "pending",
  "backlog",
  "done",
  "archived",
]);
export type ProjectIssueStatus = typeof ProjectIssueStatus.Type;

/** Where a captured request came from: the message Brad typed and its thread. */
export const ProjectIssueRequestSource = Schema.Struct({
  threadId: ThreadId,
  rootThreadId: ThreadId,
  messageId: TrimmedNonEmptyString,
});
export type ProjectIssueRequestSource = typeof ProjectIssueRequestSource.Type;

export const ProjectIssue = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  title: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  status: ProjectIssueStatus,
  labels: Schema.Array(Schema.String),
  /** Labeled `ask`: a request Brad made, captured into the ledger. */
  isRequest: Schema.Boolean,
  requestSource: Schema.NullOr(ProjectIssueRequestSource),
  assignees: Schema.Array(Schema.String),
  comments: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  /** Threads in the project tree that link this issue. */
  linkedThreadIds: Schema.Array(ThreadId),
  /** For a request waiting on Brad: the newest comment, usually the agent's answer or summary. */
  latestComment: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ author: Schema.String, body: Schema.String, createdAt: IsoDateTime }),
    ),
  ),
});
export type ProjectIssue = typeof ProjectIssue.Type;

export const ProjectIssueRepository = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  /** Set when this repository could not be read; its issues are absent. */
  error: Schema.NullOr(Schema.String),
});
export type ProjectIssueRepository = typeof ProjectIssueRepository.Type;

export const ProjectIssuesListInput = Schema.Struct({
  /** The orchestrator thread whose tree defines the project. */
  rootThreadId: ThreadId,
});
export type ProjectIssuesListInput = typeof ProjectIssuesListInput.Type;

export const ProjectIssuesListResult = Schema.Struct({
  repositories: Schema.Array(ProjectIssueRepository),
  issues: Schema.Array(ProjectIssue),
  fetchedAt: IsoDateTime,
});
export type ProjectIssuesListResult = typeof ProjectIssuesListResult.Type;

/** Brad settles a request: closes its issue. Settling is only ever Brad's action. */
export const ProjectRequestSettleInput = Schema.Struct({
  rootThreadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ProjectRequestSettleInput = typeof ProjectRequestSettleInput.Type;

export const ProjectRequestSettleResult = Schema.Struct({ settled: Schema.Boolean });
export type ProjectRequestSettleResult = typeof ProjectRequestSettleResult.Type;

/** Request kinds; each has its own lifecycle on the project page. */
export const ProjectRequestKind = Schema.Literals([
  "question",
  "deliverable",
  "plan",
  "change",
  "test",
]);
export type ProjectRequestKind = typeof ProjectRequestKind.Type;

/** An agent files a request on Brad's behalf, in the tracker of its thread's project tree. */
export const ProjectRequestCreateInput = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  kind: ProjectRequestKind,
  detail: Schema.optionalKey(Schema.String),
});
export type ProjectRequestCreateInput = typeof ProjectRequestCreateInput.Type;

/**
 * An agent moves a request: `in-progress` when it starts, `needs-review` when the
 * answer, draft or plan is ready for Brad (with a summary comment). Settling is
 * not an agent action.
 */
export const ProjectRequestUpdateInput = Schema.Struct({
  threadId: ThreadId,
  /** Issue number in the project's tracker repository, or a full issue URL. */
  reference: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "in-progress", "needs-review"]),
  comment: Schema.optionalKey(Schema.String),
});
export type ProjectRequestUpdateInput = typeof ProjectRequestUpdateInput.Type;

export const ProjectRequestRef = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ProjectRequestRef = typeof ProjectRequestRef.Type;

export const ProjectRequestsListInput = Schema.Struct({ threadId: ThreadId });
export type ProjectRequestsListInput = typeof ProjectRequestsListInput.Type;

export class ProjectIssuesError extends Schema.TaggedError<ProjectIssuesError>()(
  "ProjectIssuesError",
  { message: Schema.String },
) {}
