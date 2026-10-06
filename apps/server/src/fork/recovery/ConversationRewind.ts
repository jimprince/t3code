import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import type { ProviderSessionManagerV2 } from "../../orchestration-v2/ProviderSessionManager.ts";
import type { EventSinkV2 } from "../../orchestration-v2/EventSink.ts";
import type { IdAllocatorV2 } from "@t3tools/provider-core/server/IdAllocator";
import type { RuntimePolicyV2 } from "../../orchestration-v2/RuntimePolicy.ts";
import type { ThreadCommandExecutor } from "../../orchestration-v2/ThreadCommandExecutor.ts";

export const ConversationBaseline = Schema.Struct({
  threadId: ThreadId,
  commandId: CommandId,
  runId: RunId,
  messageId: MessageId,
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerInstanceId: ProviderInstanceId,
});
export type ConversationBaseline = typeof ConversationBaseline.Type;
export class ConversationRewindError extends Schema.TaggedError<ConversationRewindError>()(
  "ConversationRewindError",
  { threadId: ThreadId, reason: Schema.String },
) {}
const isConversationRewindError = Schema.is(ConversationRewindError);
/** The baseline is a new conversation boundary, never an invented filesystem checkpoint. */
export function conversationBaselineAllowed(
  projection: OrchestrationV2ThreadProjection,
  input: ConversationBaseline,
): boolean {
  const latest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  return (
    projection.thread.deletedAt === null &&
    projection.thread.archivedAt === null &&
    projection.thread.modelSelection.instanceId === input.providerInstanceId &&
    projection.thread.activeProviderThreadId === input.providerThreadId &&
    latest?.id === input.runId &&
    latest.userMessageId === input.messageId &&
    latest.providerInstanceId === input.providerInstanceId &&
    (latest.status === "interrupted" || latest.status === "failed") &&
    !projection.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) &&
    projection.runs.every(
      (run) =>
        run.status === "rolled_back" ||
        (run.providerInstanceId === input.providerInstanceId &&
          (run.providerThreadId === null || run.providerThreadId === input.providerThreadId)),
    ) &&
    !projection.providerThreads.some(
      (thread) => (thread.pendingBackgroundTasks?.length ?? 0) > 0,
    ) &&
    !projection.runtimeRequests.some((request) => request.status === "pending") &&
    !projection.checkpoints.some(
      (checkpoint) =>
        checkpoint.status === "ready" && (checkpoint.appRunOrdinal ?? 0) < latest.ordinal,
    )
  );
}
export function makeConversationRewind(deps: {
  projections: ProjectionStoreV2["Service"];
  sessions: ProviderSessionManagerV2["Service"];
  eventSink: EventSinkV2["Service"];
  ids: IdAllocatorV2["Service"];
  runtimePolicy: RuntimePolicyV2["Service"];
  threadLock: ThreadCommandExecutor["Service"];
}) {
  return (input: ConversationBaseline) =>
    deps.threadLock
      .withLock(
        input.threadId,
        Effect.gen(function* () {
          const projection = yield* deps.projections.getThreadProjection(input.threadId);
          if (
            projection.thread.rollbackRequestId === input.commandId &&
            projection.runs.find((run) => run.id === input.runId)?.status === "rolled_back"
          )
            return;
          if (
            !conversationBaselineAllowed(projection, input) ||
            projection.thread.rollbackRequestId !== input.commandId
          )
            return yield* new ConversationRewindError({
              threadId: input.threadId,
              reason: "The terminal run or provider changed before conversation rewind.",
            });
          const providerThread = projection.providerThreads.find(
            (thread) => thread.id === input.providerThreadId,
          );
          const now = yield* DateTime.now;
          const events: Array<OrchestrationV2DomainEvent> = [];
          if (providerThread !== undefined) {
            if (
              providerThread.providerSessionId === null ||
              providerThread.providerInstanceId !== input.providerInstanceId
            )
              return yield* new ConversationRewindError({
                threadId: input.threadId,
                reason: "The provider session is unavailable.",
              });
            const existingSession = projection.providerSessions.find(
              (session) => session.id === providerThread.providerSessionId,
            );
            const runtimePolicy = yield* deps.runtimePolicy.resolve({
              thread: projection.thread,
              modelSelection: projection.thread.modelSelection,
            });
            const session = yield* deps.sessions.open({
              threadId: input.threadId,
              providerSessionId: providerThread.providerSessionId,
              modelSelection: projection.thread.modelSelection,
              runtimePolicy,
              ...(existingSession === undefined ? {} : { resumeFromSession: existingSession }),
              ...(providerThread.nativeThreadRef?.nativeId == null
                ? {}
                : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
            });
            // The adapter resets the conversation; no filesystem ref is created.
            const snapshot = yield* session.rollbackThread({
              providerThread,
              target: { type: "thread_start", appRunOrdinal: 0 },
              providerThreadTurns: projection.providerTurns.filter(
                (turn) => turn.providerThreadId === providerThread.id,
              ),
            });
            events.push({
              id: yield* deps.ids.allocate.event({ threadId: input.threadId }),
              type: "provider-thread.updated",
              threadId: input.threadId,
              occurredAt: now,
              providerInstanceId: input.providerInstanceId,
              driver: providerThread.driver,
              payload: { ...snapshot.providerThread, lastRunOrdinal: null, updatedAt: now },
            });
          }
          for (const run of projection.runs) {
            if (!["completed", "interrupted", "failed", "cancelled"].includes(run.status)) continue;
            events.push({
              id: yield* deps.ids.allocate.event({ threadId: input.threadId }),
              type: "run.updated",
              threadId: input.threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, status: "rolled_back", completedAt: now },
            });
            const node = projection.nodes.find((node) => node.id === run.rootNodeId);
            if (node !== undefined)
              events.push({
                id: yield* deps.ids.allocate.event({ threadId: input.threadId }),
                type: "node.updated",
                threadId: input.threadId,
                runId: run.id,
                nodeId: node.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: { ...node, status: "rolled_back", completedAt: now },
              });
          }
          yield* deps.eventSink.write({ events });
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          isConversationRewindError(cause)
            ? cause
            : new ConversationRewindError({
                threadId: input.threadId,
                reason: "The provider could not rewind this conversation.",
              }),
        ),
      );
}
