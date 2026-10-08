import {
  MessageId,
  MessageForwardError,
  type MessageForwardSource,
  type MessageForwardBundle,
  type MessageForwardAcceptInput,
  type HandoffAcceptInput,
  type HandoffReceipt,
  type HandoffError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import {
  claimForwardAttachments,
  verifyForwardAttachments,
  validateForwardAttachments,
} from "./ForwardAttachments.ts";
import { stableStringify } from "@t3tools/shared/relaySigning";

const failure = (message: string) => new MessageForwardError({ message });

/** Both transports use this path. Attachment copies never leave the attachment store. */
export const makeMessageForwardService = (
  sql: SqlClient.SqlClient,
  threads: ThreadManagementServiceShape,
  send: (input: HandoffAcceptInput) => Effect.Effect<HandoffReceipt, HandoffError>,
) => {
  const prepare = Effect.fn("MessageForward.prepare")(function* (source: MessageForwardSource) {
    yield* threads.ensureLegacyTranscript(source.threadId);
    const shell = yield* threads.getThreadShell(source.threadId);
    if (!shell || shell.deletedAt !== null) return yield* failure("Source thread not found.");
    let messageId: MessageId;
    if (source.selection.type === "message") {
      messageId = source.selection.messageId;
    } else {
      // Agent handoffs, notifications and scheduled wakes also have the user role.
      // Last-user means the last human-authored message, not the last wake.
      const rows = yield* sql<{
        message_id: string;
      }>`SELECT message_id FROM orchestration_v2_projection_messages WHERE thread_id=${source.threadId} AND role='user' AND json_extract(payload_json,'$.createdBy')='user' AND json_extract(payload_json,'$.notification') IS NULL AND json_extract(payload_json,'$.scheduledTaskId') IS NULL AND json_extract(payload_json,'$.senderThreadId') IS NULL ORDER BY created_at DESC,message_id DESC LIMIT 1`;
      if (!rows[0]) return yield* failure("No human-authored user message was found.");
      messageId = MessageId.make(rows[0].message_id);
    }
    const records = yield* threads.getThreadRecords(source.threadId, ["messages"], {
      messageIds: [messageId],
    });
    const message = records.messages.find((row) => row.id === messageId);
    if (!message || message.streaming)
      return yield* failure("Source message is missing or still streaming.");
    yield* verifyForwardAttachments(message.attachments);
    return {
      sourceThreadId: source.threadId,
      sourceMessageId: message.id,
      sourceProjectId: shell.projectId,
      sourceTitle: shell.title,
      author:
        message.role !== "user"
          ? message.role
          : message.createdBy === "agent" || message.senderThreadId !== undefined
            ? "agent"
            : message.createdBy === "user" &&
                message.scheduledTaskId === undefined &&
                message.notification === undefined
              ? "user"
              : "system",
      text: message.text,
      attachments: message.attachments,
    } satisfies MessageForwardBundle;
  });
  const accept = Effect.fn("MessageForward.accept")(function* (input: MessageForwardAcceptInput) {
    yield* validateForwardAttachments(input.bundle.attachments);
    const references = input.bundle.attachments;
    if (input.stagedAttachments === undefined) {
      const canonical = yield* prepare({
        threadId: input.bundle.sourceThreadId,
        selection: { type: "message", messageId: input.bundle.sourceMessageId },
      });
      if (
        canonical.text !== input.bundle.text ||
        canonical.author !== input.bundle.author ||
        stableStringify(canonical.attachments) !== stableStringify(references)
      )
        return yield* failure("The source message changed; prepare it again before forwarding.");
    }
    const url = yield* Effect.try({
      try: () => new URL(input.sourceUrl),
      catch: () => failure("Pass an absolute source message URL."),
    });
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
      return yield* failure("Pass an HTTP(S) source message URL without credentials.");
    const author = input.bundle.author === "user" ? "Brad" : input.bundle.author;
    const text = `From ${author} via ${input.senderName}, ${input.sourceUrl}\n${input.note === undefined ? "" : `Routing note: ${input.note}\n`}\n${input.bundle.text}`;
    if (text.length > 1_000_000)
      return yield* failure("Forwarded message exceeds the send text limit.");
    const shell = yield* threads.getThreadShell(input.recipientThreadId);
    if (!shell || shell.deletedAt !== null) return yield* failure("Target thread not found.");
    const imported = yield* claimForwardAttachments({
      recipientThreadId: input.recipientThreadId,
      sendId: input.sendId,
      references,
      ...(input.stagedAttachments === undefined
        ? {}
        : { stagedAttachments: input.stagedAttachments }),
    });
    // A lost dispatch response may follow a committed message. Retain imported
    // files on uncertain failures; deterministic IDs make an explicit retry safe.
    const receipt = yield* send({
      sendId: input.sendId,
      recipientThreadId: input.recipientThreadId,
      ...(input.senderThreadId ? { senderThreadId: input.senderThreadId } : {}),
      ...(input.context ? { context: input.context } : {}),
      text,
      attachments: imported.attachments,
      coalesceKey: input.coalesceKey,
      intent: input.intent,
      ...(input.allowQueueFallback === undefined
        ? {}
        : { allowQueueFallback: input.allowQueueFallback }),
    }).pipe(
      Effect.tapError((error) =>
        error.causeCode === "SEND_ID_CONFLICT" ? imported.cleanup : Effect.void,
      ),
    );
    if (receipt.status === "refused") yield* imported.cleanup;
    return { ...receipt, forwardedMessage: { text, attachments: imported.attachments } };
  });
  return {
    prepare: (input: MessageForwardSource) =>
      prepare(input).pipe(
        Effect.mapError((error) =>
          error._tag === "MessageForwardError"
            ? error
            : failure("Unable to read the source message and all of its attachments."),
        ),
      ),
    accept: (input: MessageForwardAcceptInput) =>
      accept(input).pipe(
        Effect.mapError((error) =>
          error._tag === "HandoffError" || error._tag === "MessageForwardError"
            ? error
            : failure("Unable to forward the message and all of its attachments."),
        ),
      ),
  };
};
