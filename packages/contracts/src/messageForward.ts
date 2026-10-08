import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { MessageId, ThreadId } from "./baseSchemas.ts";
import { ChatAttachment, PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "./chatAttachment.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { HandoffAcceptInput, HandoffReceipt, HandoffError } from "./handoffs.ts";

export const MessageForwardSource = Schema.Struct({
  threadId: ThreadId,
  selection: Schema.Union([
    Schema.Struct({ type: Schema.Literal("message"), messageId: MessageId }),
    Schema.Struct({ type: Schema.Literal("last-user") }),
  ]),
});
export type MessageForwardSource = typeof MessageForwardSource.Type;

// Source text and attachment metadata. Bytes travel through existing signed asset/upload paths.
export const MessageForwardBundle = Schema.Struct({
  sourceThreadId: ThreadId,
  sourceMessageId: MessageId,
  sourceProjectId: Schema.String,
  sourceTitle: Schema.String,
  author: Schema.Literals(["user", "assistant", "system", "agent"]),
  text: Schema.String.check(Schema.isMaxLength(1_000_000)),
  attachments: Schema.Array(ChatAttachment).check(
    Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
  ),
});
export type MessageForwardBundle = typeof MessageForwardBundle.Type;
export const MessageForwardAcceptInput = Schema.Struct({
  sendId: HandoffAcceptInput.fields.sendId,
  recipientThreadId: HandoffAcceptInput.fields.recipientThreadId,
  senderThreadId: HandoffAcceptInput.fields.senderThreadId,
  context: HandoffAcceptInput.fields.context,
  coalesceKey: HandoffAcceptInput.fields.coalesceKey,
  allowQueueFallback: HandoffAcceptInput.fields.allowQueueFallback,
  intent: HandoffAcceptInput.fields.intent,
  bundle: MessageForwardBundle,
  stagedAttachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  sourceUrl: Schema.String.check(Schema.isMaxLength(4096)),
  senderName: Schema.String.check(Schema.isMaxLength(256)),
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(16000))),
});
export type MessageForwardAcceptInput = typeof MessageForwardAcceptInput.Type;
export const MessageForwardResult = Schema.Struct({
  ...HandoffReceipt.fields,
  forwardedMessage: Schema.Struct({
    text: Schema.String,
    attachments: Schema.Array(ChatAttachment).check(
      Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
    ),
  }),
});
export type MessageForwardResult = typeof MessageForwardResult.Type;
export class MessageForwardError extends Schema.TaggedError<MessageForwardError>()(
  "MessageForwardError",
  { message: Schema.String },
) {}
export const MessageForwardRpcs = [
  Rpc.make("fork.message.forward.prepare", {
    payload: MessageForwardSource,
    success: MessageForwardBundle,
    error: Schema.Union([MessageForwardError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("fork.message.forward.accept", {
    payload: MessageForwardAcceptInput,
    success: MessageForwardResult,
    error: Schema.Union([MessageForwardError, HandoffError, EnvironmentAuthorizationError]),
  }),
] as const;
