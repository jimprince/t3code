import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";

export const HandoffSendId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9._:-]{1,128}$/));
export const HandoffCause = Schema.Literals([
  "SETTLED",
  "ARCHIVED",
  "NOT_FOUND",
  "QUOTA_EXHAUSTED",
  "SEND_ID_CONFLICT",
  "ACCESS_DENIED",
  "DISPATCH_REJECTED",
  "TRANSPORT_TIMEOUT",
  "TRANSPORT_OS_ERROR",
  "INTERRUPTED",
  "TRANSPORT_ERROR",
  "PERSISTENCE_FAILED",
  "RECEIPTS_UNAVAILABLE",
  "CANCELLED",
  "BUSY",
  "DORMANT",
]);
export const HandoffReceipt = Schema.Struct({
  sendId: HandoffSendId,
  recipientThreadId: ThreadId,
  acceptedAt: Schema.String,
  status: Schema.Literals([
    "accepted",
    "started",
    "steered",
    "queued",
    "held",
    "refused",
    "superseded",
    "cancelled",
  ]),
  cause: Schema.NullOr(HandoffCause),
  ownerThreadId: Schema.NullOr(ThreadId),
});
export type HandoffReceipt = typeof HandoffReceipt.Type;
export const HandoffAcceptInput = Schema.Struct({
  sendId: HandoffSendId,
  recipientThreadId: ThreadId,
  senderThreadId: Schema.optional(ThreadId),
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
  coalesceKey: Schema.NullOr(Schema.String.check(Schema.isMaxLength(128))),
  allowQueueFallback: Schema.optional(Schema.Boolean),
  intent: Schema.Literals(["auto", "control", "queue"]),
});
export type HandoffAcceptInput = typeof HandoffAcceptInput.Type;
export class HandoffError extends Schema.TaggedError<HandoffError>()("HandoffError", {
  causeCode: HandoffCause,
}) {}
export const HandoffLookupInput = Schema.Union([
  Schema.Struct({ type: Schema.Literal("exact"), sendId: HandoffSendId }),
  Schema.Struct({
    type: Schema.Literal("coalesce"),
    recipientThreadId: ThreadId,
    coalesceKey: Schema.String.check(Schema.isMaxLength(128)),
    since: Schema.String,
    until: Schema.String,
  }),
]);
export type HandoffLookupInput = typeof HandoffLookupInput.Type;
export const HandoffLookupResult = Schema.Struct({
  state: Schema.Literals(["found", "unknown", "multiple"]),
  receipts: Schema.Array(HandoffReceipt).check(Schema.isMaxLength(50)),
  retentionDays: Schema.Literal(30),
  truncated: Schema.optional(Schema.Boolean),
});
export type HandoffLookupResult = typeof HandoffLookupResult.Type;
export const HandoffRpcs = [
  Rpc.make("fork.send.accept", {
    payload: HandoffAcceptInput,
    success: HandoffReceipt,
    error: Schema.Union([HandoffError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("fork.send.lookup", {
    payload: HandoffLookupInput,
    success: HandoffLookupResult,
    error: Schema.Union([HandoffError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("fork.send.inbox", {
    payload: Schema.Struct({ threadId: ThreadId }),
    success: HandoffLookupResult,
    error: Schema.Union([HandoffError, EnvironmentAuthorizationError]),
  }),
] as const;
