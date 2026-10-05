import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

/**
 * A `needs-brad` issue in the fixed decision format: the context before the fenced
 * `decision` block, who is waiting for the answer, and the options (none for an open
 * question). Parsed by the server so every client shows the same thing.
 */
export const ProjectIssueDecision = Schema.Struct({
  context: Schema.String,
  /** A saved agent name or thread id; the block's `waiting:` line, else chief-of-staff-inbox. */
  waiting: Schema.String,
  options: Schema.Array(Schema.Struct({ text: Schema.String, recommended: Schema.Boolean })),
});
export type ProjectIssueDecision = typeof ProjectIssueDecision.Type;

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
  /** Set on an open issue labeled `needs-brad`: a decision waiting on Brad. */
  decision: Schema.optionalKey(ProjectIssueDecision),
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
 * Item types, stored as `ask:<kind>` labels on requests and issues alike; each has
 * its own lifecycle on the project page. A task may also carry a `bug` tag.
 */
const ProjectRequestKindCurrent = Schema.Literals(["question", "task", "epic"]);

/** The earlier item types and the type each one is read as. */
const LEGACY_REQUEST_KINDS = {
  bug: "task",
  feature: "task",
  deliverable: "task",
  change: "task",
  test: "task",
  maintenance: "task",
  plan: "epic",
} as const;

type LegacyRequestKind = keyof typeof LEGACY_REQUEST_KINDS;
type CurrentRequestKind = typeof ProjectRequestKindCurrent.Type;

/** The current type for a stored or received type, mapping an earlier one. */
export const normalizeRequestKind = (kind: string): CurrentRequestKind =>
  Object.hasOwn(LEGACY_REQUEST_KINDS, kind)
    ? LEGACY_REQUEST_KINDS[kind as LegacyRequestKind]
    : (kind as CurrentRequestKind);

/** Decodes the three types, and maps an earlier type from an older client or outbox entry. */
export const ProjectRequestKind = Schema.Literals([
  "question",
  "task",
  "epic",
  ...(Object.keys(LEGACY_REQUEST_KINDS) as LegacyRequestKind[]),
]).pipe(
  Schema.decodeTo(
    ProjectRequestKindCurrent,
    SchemaTransformation.transform({
      decode: (kind: CurrentRequestKind | LegacyRequestKind) => normalizeRequestKind(kind),
      encode: (kind: CurrentRequestKind): CurrentRequestKind | LegacyRequestKind => kind,
    }),
  ),
);
export type ProjectRequestKind = typeof ProjectRequestKind.Type;

/** A captured request not yet filed, usually because Gitea was unreachable; retried. */
export const ProjectPendingRequest = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  threadId: ThreadId,
  title: Schema.String,
  /** Null until the message has been split into requests. */
  kind: Schema.NullOr(ProjectRequestKind),
  /** The split tagged it a bug. */
  bug: Schema.optionalKey(Schema.Boolean),
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
 * Brad decides an item waiting on him from Needs you. `approve` and `option` start
 * the work (comment, in progress, one message to the thread on it); `not-yet`
 * returns the item to Pending with his reason and sends nothing. On a `needs-brad`
 * decision issue, `option` and `answer` comment, remove the label and send the answer
 * to the thread the issue says is waiting; the issue stays open.
 */
export const ProjectRequestDecideInput = Schema.Struct({
  /** A thread of the project tree, as in `ProjectRequestUpdateInput`. */
  threadId: ThreadId,
  /** Issue number in the project's tracker repository, `owner/repo#N`, or a full issue URL. */
  reference: TrimmedNonEmptyString,
  decision: Schema.Literals(["approve", "not-yet", "option", "answer"]),
  /** The option Brad chose (with `option`). */
  option: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
  /** Brad's own answer to an open question (with `answer`). */
  answer: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2000))),
  /** Why not yet (with `not-yet`), or the short note that goes with an answer; one line. */
  reason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(500))),
});
export type ProjectRequestDecideInput = typeof ProjectRequestDecideInput.Type;

export const ProjectRequestDecideResult = Schema.Struct({
  /** The thread that was told to go ahead; null for Not yet or when it could not be messaged. */
  notifiedThreadId: Schema.NullOr(ThreadId),
});
export type ProjectRequestDecideResult = typeof ProjectRequestDecideResult.Type;

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
  /** Tags a task `bug`. */
  bug: Schema.optionalKey(Schema.Boolean),
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
  /**
   * Retypes the item: swaps among `ask:question`, `ask:task` and `ask:epic`, keeping
   * any earlier `ask:*` label as history. Any tracker issue can be typed.
   */
  kind: Schema.optionalKey(ProjectRequestKind),
  /** Retitles the task (an imperative for work, the question for a question). */
  title: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  /** Adds or removes the `bug` tag. */
  bug: Schema.optionalKey(Schema.Boolean),
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
