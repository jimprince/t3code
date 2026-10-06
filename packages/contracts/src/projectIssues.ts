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

export class ProjectIssuesError extends Schema.TaggedError<ProjectIssuesError>()(
  "ProjectIssuesError",
  { message: Schema.String },
) {}
