import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { ChatAttachment } from "./chatAttachment.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ThreadId,
  RunId,
  ProviderSessionId,
  NonNegativeInt,
  MessageId,
  TurnItemId,
} from "./baseSchemas.ts";

export class ThreadRecoveryError extends Schema.TaggedError<ThreadRecoveryError>()(
  "ThreadRecoveryError",
  {
    code: Schema.Literals([
      "forbidden",
      "not_found",
      "conflict",
      "unsupported",
      "pending",
      "storage",
      "teardown",
    ]),
    message: Schema.String,
  },
) {}
export const RecoveryRequest = Schema.Struct({
  requestId: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  reason: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export const SessionResetReason = Schema.Literals([
  "watchdog_force",
  "operator_reset",
  "discard_native",
]);
export type SessionResetReason = typeof SessionResetReason.Type;
export const SessionResetInput = Schema.Struct({
  ...RecoveryRequest.fields,
  reason: SessionResetReason,
  threadId: ThreadId,
  runId: RunId,
  expectedGeneration: NonNegativeInt,
});
export type SessionResetInput = typeof SessionResetInput.Type;
export const SessionResetReceipt = Schema.Struct({
  requestId: Schema.String,
  threadId: ThreadId,
  runId: RunId,
  providerSessionId: ProviderSessionId,
  oldGeneration: NonNegativeInt,
  newGeneration: NonNegativeInt,
  status: Schema.Literals(["fenced", "completed"]),
  isolation: Schema.NullOr(Schema.Literals(["session", "thread"])),
  principal: Schema.String,
});
export type SessionResetReceipt = typeof SessionResetReceipt.Type;
export const HandoverPrepareInput = Schema.Struct({
  ...RecoveryRequest.fields,
  oldThreadId: ThreadId,
  successorThreadId: ThreadId,
  expectedGeneration: NonNegativeInt,
  requiredEnvironments: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMinLength(1))),
});
export type HandoverPrepareInput = typeof HandoverPrepareInput.Type;
export const HandoverItemReceipt = Schema.Struct({
  kind: Schema.Literals([
    "subscription",
    "notification",
    "queued-send",
    "alias",
    "child",
    "layout",
    "automation",
    "pin",
    "lifecycle",
  ]),
  id: Schema.String,
  before: Schema.Unknown,
  after: Schema.Unknown,
  principal: Schema.String,
});
export type HandoverItemReceipt = typeof HandoverItemReceipt.Type;
export const HandoverRoutesInput = Schema.Struct({
  ...RecoveryRequest.fields,
  transferId: Schema.String,
  oldThreadId: ThreadId,
  successorThreadId: ThreadId,
  targetEnvironment: Schema.String,
  expectedGeneration: NonNegativeInt,
});
export type HandoverRoutesInput = typeof HandoverRoutesInput.Type;
export const HandoverHostReceipt = Schema.Struct({
  transferId: Schema.String,
  environment: Schema.String,
  oldThreadId: ThreadId,
  successorThreadId: ThreadId,
  oldGeneration: NonNegativeInt,
  newGeneration: NonNegativeInt,
  digest: Schema.String,
  items: Schema.Array(HandoverItemReceipt),
  principal: Schema.String,
});
export type HandoverHostReceipt = typeof HandoverHostReceipt.Type;
export const HandoverStatusInput = Schema.Struct({ transferId: Schema.String });
export const HandoverCommitInput = Schema.Struct({
  transferId: Schema.String,
  requestId: Schema.String,
  hostReceipts: Schema.Array(HandoverHostReceipt),
});
export type HandoverCommitInput = typeof HandoverCommitInput.Type;
export const HandoverReceipt = Schema.Struct({
  transferId: Schema.String,
  requestId: Schema.String,
  oldThreadId: ThreadId,
  successorThreadId: ThreadId,
  oldGeneration: NonNegativeInt,
  newGeneration: NonNegativeInt,
  status: Schema.Literals(["prepared", "pending-host", "committing", "completed"]),
  requiredEnvironments: Schema.Array(Schema.String),
  hostReceipts: Schema.Array(HandoverHostReceipt),
  items: Schema.Array(HandoverItemReceipt),
  watermark: Schema.NullOr(MessageId),
  principal: Schema.String,
});
export type HandoverReceipt = typeof HandoverReceipt.Type;
export const HumanPendingInput = Schema.Struct({
  threadId: ThreadId,
  afterMessageId: Schema.optionalKey(MessageId),
});
export type HumanPendingInput = typeof HumanPendingInput.Type;
export const HumanPendingRequest = Schema.Struct({
  itemId: Schema.NullOr(TurnItemId),
  messageId: MessageId,
  runId: Schema.NullOr(RunId),
  createdAt: Schema.String,
  origin: Schema.Literals(["human", "unknown"]),
  principal: Schema.NullOr(Schema.String),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  disposition: Schema.Literals(["pending", "verification-required"]),
});
export const HumanResolveInput = Schema.Struct({
  threadId: ThreadId,
  itemIds: Schema.Array(TurnItemId).pipe(Schema.check(Schema.isMinLength(1))),
  reference: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
});
export type HumanResolveInput = typeof HumanResolveInput.Type;
export const HumanPendingResult = Schema.Struct({
  threadId: ThreadId,
  watermark: Schema.NullOr(MessageId),
  requests: Schema.Array(HumanPendingRequest),
});
export type HumanPendingResult = typeof HumanPendingResult.Type;
const error = Schema.Union([EnvironmentAuthorizationError, ThreadRecoveryError]);
export const ThreadRecoveryRpcs = [
  Rpc.make("thread.session.reset", {
    payload: SessionResetInput,
    success: SessionResetReceipt,
    error,
  }),
  Rpc.make("thread.handover.prepare", {
    payload: HandoverPrepareInput,
    success: HandoverReceipt,
    error,
  }),
  Rpc.make("thread.handover.commit", {
    payload: HandoverCommitInput,
    success: HandoverReceipt,
    error,
  }),
  Rpc.make("thread.handover.status", {
    payload: HandoverStatusInput,
    success: HandoverReceipt,
    error,
  }),
  Rpc.make("thread.handover.routes", {
    payload: HandoverRoutesInput,
    success: HandoverHostReceipt,
    error,
  }),
  Rpc.make("thread.human.resolve", {
    payload: HumanResolveInput,
    success: HumanPendingResult,
    error,
  }),
  Rpc.make("thread.human.pending", {
    payload: HumanPendingInput,
    success: HumanPendingResult,
    error,
  }),
] as const;
