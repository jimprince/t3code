import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

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
  /** Which request split from the message, so a retried filing is recognised (absent = 0). */
  item: Schema.optionalKey(NonNegativeInt),
});
export type ProjectIssueRequestSource = typeof ProjectIssueRequestSource.Type;

/**
 * A request's stage: requested, in progress, ready for Brad's review, handed over
 * and waiting for the release batch, shipped and waiting for his test, settled.
 */
export const ProjectRequestStage = Schema.Literals([
  "requested",
  "in-progress",
  "ready",
  "awaiting-release",
  "needs-test",
  "settled",
]);
export type ProjectRequestStage = typeof ProjectRequestStage.Type;

/** A Gitea milestone: a version on the roadmap, or the release a request shipped in. */
export const ProjectMilestone = Schema.Struct({
  id: PositiveInt,
  title: TrimmedNonEmptyString,
});
export type ProjectMilestone = typeof ProjectMilestone.Type;

/**
 * How far an epic (an `ask:epic` issue, or an older `ask:plan`) has come: its
 * children are the issues its body checklist names plus those whose body starts
 * "Part of #N". A child is done when it is closed or ticked in the checklist.
 */
export const ProjectEpicProgress = Schema.Struct({
  done: NonNegativeInt,
  total: NonNegativeInt,
  /** The children still open, in the epic's repository, for the phase word. */
  remaining: Schema.Array(PositiveInt),
});
export type ProjectEpicProgress = typeof ProjectEpicProgress.Type;

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
  /** Set for requests (issues labeled ask). */
  stage: Schema.optionalKey(ProjectRequestStage),
  milestone: Schema.optionalKey(Schema.NullOr(ProjectMilestone)),
  /** Set for epics. */
  epic: Schema.optionalKey(ProjectEpicProgress),
  /** Same-repository issue numbers its body or newest comment says it is "Blocked by". */
  blockedBy: Schema.optionalKey(Schema.Array(PositiveInt)),
  /** For a request waiting on Brad: the newest comment, usually the agent's answer or summary. */
  latestComment: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({ author: Schema.String, body: Schema.String, createdAt: IsoDateTime }),
    ),
  ),
  /**
   * For an open request: the thread's reply to the message that filed it (the
   * last assistant message of the turn that message started), so each question
   * shows its own answer. Absent until that turn has replied.
   */
  answer: Schema.optionalKey(
    Schema.Struct({ text: Schema.String, askedAt: IsoDateTime, answeredAt: IsoDateTime }),
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

/** One issue opened in the app: its body and recent comments, plus children of an epic. */
export const ProjectIssuesGetInput = Schema.Struct({
  rootThreadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
});
export type ProjectIssuesGetInput = typeof ProjectIssuesGetInput.Type;

export const ProjectIssueComment = Schema.Struct({
  author: Schema.String,
  body: Schema.String,
  createdAt: IsoDateTime,
});
export type ProjectIssueComment = typeof ProjectIssueComment.Type;

export const ProjectIssuesGetResult = Schema.Struct({
  issue: ProjectIssue,
  body: Schema.String,
  /** Oldest first; only the latest few. */
  comments: Schema.Array(ProjectIssueComment),
  /** Numbers of issues in the same repository whose body starts "Part of #<number>". */
  childNumbers: Schema.Array(PositiveInt),
});
export type ProjectIssuesGetResult = typeof ProjectIssuesGetResult.Type;

/**
 * Task types, stored as `ask:<kind>` labels on requests and issues alike; each has
 * its own lifecycle on the project page.
 */
export const ProjectRequestKind = Schema.Literals([
  "bug",
  "feature",
  "question",
  "deliverable",
  "plan",
  "change",
  "test",
  "maintenance",
]);
export type ProjectRequestKind = typeof ProjectRequestKind.Type;

/** A captured request not yet filed, usually because Gitea was unreachable; retried. */
export const ProjectPendingRequest = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: Schema.String,
  /** Null until the message has been split into requests. */
  kind: Schema.NullOr(ProjectRequestKind),
  capturedAt: IsoDateTime,
  attempts: NonNegativeInt,
  lastError: Schema.NullOr(Schema.String),
});
export type ProjectPendingRequest = typeof ProjectPendingRequest.Type;

export const ProjectIssuesListResult = Schema.Struct({
  repositories: Schema.Array(ProjectIssueRepository),
  issues: Schema.Array(ProjectIssue),
  fetchedAt: IsoDateTime,
  /** Requests captured in this project that are still waiting to be filed. */
  pendingRequests: Schema.optionalKey(Schema.Array(ProjectPendingRequest)),
});
export type ProjectIssuesListResult = typeof ProjectIssuesListResult.Type;

/** Brad settles a request: closes its issue. Settling is only ever Brad's action. */
export const ProjectRequestSettleInput = Schema.Struct({
  rootThreadId: ThreadId,
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  /** Reopen a settled or closed issue instead of settling it. */
  reopen: Schema.optionalKey(Schema.Boolean),
});
export type ProjectRequestSettleInput = typeof ProjectRequestSettleInput.Type;

export const ProjectRequestSettleResult = Schema.Struct({ settled: Schema.Boolean });
export type ProjectRequestSettleResult = typeof ProjectRequestSettleResult.Type;

/**
 * A message from the New request box, queued as an explicit request just before it
 * is sent, so the ledger files it instead of folding it into an existing issue.
 */
export const ProjectRequestSubmitInput = Schema.Struct({
  threadId: ThreadId,
  messageId: TrimmedNonEmptyString,
  text: Schema.String.check(Schema.isMaxLength(20_000)),
});
export type ProjectRequestSubmitInput = typeof ProjectRequestSubmitInput.Type;

/**
 * The New request box: start a short-lived intake thread under the project's
 * orchestrator to triage one request, instead of sending it to the orchestrator.
 */
export const ProjectRequestStartIntakeInput = Schema.Struct({
  /** Any thread of the project; the intake nests under its orchestrator. */
  threadId: ThreadId,
  /** The request's first line, for the intake thread's title. */
  title: Schema.String.check(Schema.isMaxLength(200)),
});
export type ProjectRequestStartIntakeInput = typeof ProjectRequestStartIntakeInput.Type;

export const ProjectRequestStartIntakeResult = Schema.Struct({
  threadId: ThreadId,
  modelSelection: ModelSelection,
  /** The fixed triage brief to send ahead of Brad's words. */
  brief: Schema.String,
});
export type ProjectRequestStartIntakeResult = typeof ProjectRequestStartIntakeResult.Type;

/** An agent files a request on Brad's behalf, in the tracker of its thread's project tree. */
export const ProjectRequestCreateInput = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  kind: ProjectRequestKind,
  detail: Schema.optionalKey(Schema.String),
  /** Save for later: filed parked, so it waits on the roadmap instead of the request list. */
  park: Schema.optionalKey(Schema.Boolean),
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
  /**
   * `needs-review`: ready for Brad to look at. `awaiting-release`: handed over,
   * waiting for the release batch. `needs-test`: shipped in `release`, waiting
   * for Brad to test (`comment` is the test step).
   */
  /** Absent for a progress note: the comment is posted and the stage stays. */
  status: Schema.optionalKey(
    Schema.Literals(["pending", "in-progress", "needs-review", "awaiting-release", "needs-test"]),
  ),
  comment: Schema.optionalKey(Schema.String),
  /** Release the request shipped in, recorded as its milestone (with `needs-test`). */
  release: Schema.optionalKey(TrimmedNonEmptyString),
  /** Retypes the task: replaces its `ask:<kind>` label. Any tracker issue can be typed. */
  kind: Schema.optionalKey(ProjectRequestKind),
  /** Retitles the task (an imperative for work, the question for a question). */
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type ProjectRequestUpdateInput = typeof ProjectRequestUpdateInput.Type;

export const ProjectRequestRef = Schema.Struct({
  host: TrimmedNonEmptyString,
  repository: TrimmedNonEmptyString,
  number: PositiveInt,
  url: TrimmedNonEmptyString,
});
export type ProjectRequestRef = typeof ProjectRequestRef.Type;

/** A request an agent filed, or queued when Gitea was unreachable (filed later). */
export const ProjectRequestCreateResult = Schema.Struct({
  request: Schema.NullOr(ProjectRequestRef),
  queued: Schema.Boolean,
});
export type ProjectRequestCreateResult = typeof ProjectRequestCreateResult.Type;

export const ProjectRequestsListInput = Schema.Struct({ threadId: ThreadId });
export type ProjectRequestsListInput = typeof ProjectRequestsListInput.Type;

export class ProjectIssuesError extends Schema.TaggedError<ProjectIssuesError>()(
  "ProjectIssuesError",
  { message: Schema.String },
) {}
