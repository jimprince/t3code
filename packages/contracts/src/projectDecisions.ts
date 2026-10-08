import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  PositiveInt,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OrchestrationV2UserInputQuestion } from "./orchestrationV2.ts";
import { ProviderApprovalOption, ProviderRequestKind } from "./providerPolicy.ts";

/**
 * What a thread of the project tree is waiting on Brad for, with the text a card
 * needs. Thread shells carry only that a request is pending, so the Decisions feed
 * reads the question or approval text here, from the few threads that are waiting.
 */
const PendingAskBase = {
  threadId: ThreadId,
  threadTitle: Schema.String,
  /** The waiting thread's own project. */
  projectTitle: Schema.String,
  requestId: RuntimeRequestId,
  createdAt: IsoDateTime,
  /**
   * The thread can still take Brad's response from outside its own view; false for a
   * request that outlived its provider session, which only the thread can resolve.
   */
  canRespond: Schema.Boolean,
};

export const ProjectPendingAsk = Schema.Union([
  Schema.Struct({
    ...PendingAskBase,
    kind: Schema.Literal("question"),
    questions: Schema.Array(OrchestrationV2UserInputQuestion),
    /** The thread accepts a plain message instead of structured answers. */
    messageResponse: Schema.Boolean,
  }),
  Schema.Struct({
    ...PendingAskBase,
    kind: Schema.Literal("approval"),
    requestKind: ProviderRequestKind,
    /** The command, file or permission the thread asks to use. */
    detail: Schema.optionalKey(Schema.String),
    appName: Schema.optionalKey(Schema.String),
    options: Schema.optionalKey(Schema.Array(ProviderApprovalOption)),
  }),
]);
export type ProjectPendingAsk = typeof ProjectPendingAsk.Type;

export const ProjectPendingAsksInput = Schema.Struct({
  /** A thread of the project tree, as in `ProjectRequestsListInput`. */
  threadId: ThreadId,
});
export type ProjectPendingAsksInput = typeof ProjectPendingAsksInput.Type;

export const ProjectPendingAsksResult = Schema.Struct({
  /** Oldest first. */
  asks: Schema.Array(ProjectPendingAsk),
});
export type ProjectPendingAsksResult = typeof ProjectPendingAsksResult.Type;

/**
 * Brad approves a Review card: its pull request is merged and the issue settled.
 * Refused, with the reason, unless the pull request is open, not a draft and mergeable.
 * Safe to repeat: once merged, a retry finishes settling and returns the same result.
 */
export const ProjectRequestApproveMergeInput = Schema.Struct({
  /** A thread of the project tree, as in `ProjectRequestDecideInput`. */
  threadId: ThreadId,
  /** Issue number in the project's tracker repository, `owner/repo#N`, or a full issue URL. */
  reference: TrimmedNonEmptyString,
  /** The pull request to merge, when the issue's own pull request cannot be found. */
  pullRequest: Schema.optionalKey(PositiveInt),
  /** The head commit the card showed; the merge is refused if the branch has moved on. */
  headSha: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ProjectRequestApproveMergeInput = typeof ProjectRequestApproveMergeInput.Type;

export const ProjectRequestApproveMergeResult = Schema.Struct({
  pullRequest: Schema.Struct({ number: PositiveInt, url: Schema.String }),
  /** The worker thread told it was merged; null when none is linked or it was archived. */
  notifiedThreadId: Schema.NullOr(ThreadId),
  /** A retry: the pull request was already merged, so only what was left undone was done. */
  alreadyMerged: Schema.Boolean,
});
export type ProjectRequestApproveMergeResult = typeof ProjectRequestApproveMergeResult.Type;

/**
 * Brad sends a Review or Test card back with a note: the note is commented on the
 * issue, the issue returns to in progress (reopened if it was closed) and the thread
 * that owns it is told, or the project's orchestrator when that thread is gone.
 */
export const ProjectRequestSendBackInput = Schema.Struct({
  threadId: ThreadId,
  reference: TrimmedNonEmptyString,
  note: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export type ProjectRequestSendBackInput = typeof ProjectRequestSendBackInput.Type;

export const ProjectRequestSendBackResult = Schema.Struct({
  notifiedThreadId: Schema.NullOr(ThreadId),
  /** The owner was archived or never linked, so the orchestrator was told instead. */
  viaOrchestrator: Schema.Boolean,
});
export type ProjectRequestSendBackResult = typeof ProjectRequestSendBackResult.Type;

/**
 * Later for a card: hide it until a time, or move it to the end of the feed, or put
 * it back. Recorded on the issue, so it holds on every device. Nobody is told.
 */
export const ProjectRequestDeferInput = Schema.Struct({
  threadId: ThreadId,
  reference: TrimmedNonEmptyString,
  mode: Schema.Literals(["until", "end", "clear"]),
  /** When the card returns (with `until`); must be in the future. */
  until: Schema.optionalKey(IsoDateTime),
});
export type ProjectRequestDeferInput = typeof ProjectRequestDeferInput.Type;

export const ProjectRequestDeferResult = Schema.Struct({
  until: Schema.NullOr(IsoDateTime),
  movedToEndAt: Schema.NullOr(IsoDateTime),
});
export type ProjectRequestDeferResult = typeof ProjectRequestDeferResult.Type;
