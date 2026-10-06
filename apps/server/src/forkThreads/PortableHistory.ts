import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as EventSink from "../orchestration-v2/EventSink.ts";

export interface PortableHistoryInput {
  readonly commandId: CommandId;
  readonly thread: OrchestrationV2AppThread;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}
export class PortableHistoryError extends Schema.TaggedError<PortableHistoryError>()(
  "PortableHistoryError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}

/** Imported messages are evidence, never synthetic native runs or checkpoints.
 * V2's existing v1_import handoff budgets these null-run items on first continuation.
 */
export function portableHistoryEvents(
  input: PortableHistoryInput,
): Array<OrchestrationV2DomainEvent> {
  const threadId = input.thread.id;
  const events: Array<OrchestrationV2DomainEvent> = [
    {
      id: EventId.make(`${input.commandId}:thread`),
      type: "thread.created",
      threadId,
      occurredAt: input.thread.createdAt,
      payload: { ...input.thread, historyOrigin: "v1_import" },
    },
  ];
  input.messages.forEach((source, ordinal) => {
    const messageId = MessageId.make(`${threadId}:portable:${ordinal}`);
    const message = {
      ...source,
      id: messageId,
      threadId,
      runId: null,
      nodeId: null,
      streaming: false,
      delegatedCompletion: undefined,
    };
    const base = {
      id: TurnItemId.make(`${threadId}:portable-item:${ordinal}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: source.createdAt,
      completedAt: source.updatedAt,
      updatedAt: source.updatedAt,
    };
    const item: OrchestrationV2TurnItem =
      source.role === "user"
        ? {
            ...base,
            type: "user_message",
            messageId,
            text: source.text,
            ...(source.context === undefined ? {} : { context: source.context }),
            attachments: source.attachments,
            createdBy: source.createdBy ?? "user",
            creationSource: source.creationSource ?? "server",
            inputIntent: "turn_start",
          }
        : {
            ...base,
            type: "assistant_message",
            messageId,
            text: source.text,
            streaming: false,
            ...(source.context === undefined ? {} : { context: source.context }),
          };
    events.push(
      {
        id: EventId.make(`${input.commandId}:message:${ordinal}`),
        type: "message.updated",
        threadId,
        occurredAt: source.updatedAt,
        payload: message,
      },
      {
        id: EventId.make(`${input.commandId}:item:${ordinal}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: source.updatedAt,
        payload: item,
      },
    );
  });
  return events;
}
export class PortableHistory extends Context.Service<
  PortableHistory,
  {
    readonly import: (input: PortableHistoryInput) => Effect.Effect<void, PortableHistoryError>;
  }
>()("t3/forkThreads/PortableHistory") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  return PortableHistory.of({
    import: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const receipt = yield* receipts.getByCommandId(input.commandId);
            if (Option.isSome(receipt)) {
              if (receipt.value.threadId !== input.thread.id || receipt.value.status !== "accepted")
                return yield* new PortableHistoryError({
                  threadId: input.thread.id,
                  cause: "Import receipt identity changed.",
                });
              return;
            }
            if ((yield* projections.getThreadShell(input.thread.id)) !== null)
              return yield* new PortableHistoryError({
                threadId: input.thread.id,
                cause: "Destination thread already exists.",
              });
            yield* sink.commitCommand({
              commandId: input.commandId,
              threadId: input.thread.id,
              commandType: "fork.history.import",
              acceptedAt: input.thread.createdAt,
              events: portableHistoryEvents(input),
              effects: [],
            });
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) => new PortableHistoryError({ threadId: input.thread.id, cause }),
          ),
        ),
  });
});
export const layer = Layer.effect(PortableHistory, make);
