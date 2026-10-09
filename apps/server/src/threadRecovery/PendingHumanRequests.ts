import {
  ThreadRecoveryError,
  type HumanPendingInput,
  type HumanPendingResult,
  type HumanResolveInput,
  type ThreadId,
  type TurnItemId,
  MessageId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import { RecoveryAuthority, requireAdmin } from "./RecoveryAuthority.ts";

const failure = (cause: unknown) =>
  Schema.is(ThreadRecoveryError)(cause)
    ? cause
    : new ThreadRecoveryError({
        code: "storage",
        message: "Could not read pending human requests.",
      });
/**
 * Completed user turn items describe ingestion, not whether the user received an answer.
 * Explicit dispositions and addressedRequestIds override the run-completion rule.
 */
export class PendingHumanRequests extends Context.Service<
  PendingHumanRequests,
  {
    readonly listPending: (input: { readonly threadId: ThreadId }) => Effect.Effect<
      ReadonlyArray<{
        readonly turnItemId: TurnItemId;
        readonly sourceMessageId: MessageId;
        readonly reason: "unanswered" | "failed" | "interrupted" | "queued";
      }>,
      ThreadRecoveryError
    >;
    readonly read: (
      input: HumanPendingInput,
    ) => Effect.Effect<HumanPendingResult, ThreadRecoveryError>;
    readonly resolve: (
      input: HumanResolveInput,
    ) => Effect.Effect<HumanPendingResult, ThreadRecoveryError, RecoveryAuthority>;
  }
>()("t3/threadRecovery/PendingHumanRequests") {}
const make = Effect.gen(function* () {
  const threads = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const read = (input: HumanPendingInput) =>
    Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(input.threadId, [
        "messages",
        "turnItems",
        "runs",
      ]);
      const addressed = new Set(
        projection.messages.flatMap((m) =>
          m.role === "assistant" ? (m.addressedRequestIds ?? []) : [],
        ),
      );
      const dispositions = yield* sql<{
        message_id: string;
      }>`SELECT message_id FROM fork_recovery_human_dispositions WHERE thread_id=${input.threadId} AND disposition='addressed'`;
      for (const row of dispositions) addressed.add(MessageId.make(row.message_id));
      const unanswered = new Set(
        (yield* sql<{
          message_id: string;
        }>`SELECT message_id FROM fork_recovery_human_dispositions WHERE thread_id=${input.threadId} AND disposition='unanswered'`).map(
          (row) => MessageId.make(row.message_id),
        ),
      );
      // A request is answered once its own run, or a later one, completed with
      // assistant output. Failed, interrupted and unstarted runs stay pending.
      const runs = new Map(projection.runs.map((run) => [run.id, run]));
      const lastAnsweredOrdinal = Math.max(
        -Infinity,
        ...projection.messages.flatMap((m) => {
          const run = m.role === "assistant" && m.runId ? runs.get(m.runId) : undefined;
          return run?.status === "completed" ? [run.ordinal] : [];
        }),
      );
      const isPending = (m: (typeof projection.messages)[number]) => {
        if (unanswered.has(m.id)) return true;
        if (addressed.has(m.id)) return false;
        const run = m.runId ? runs.get(m.runId) : undefined;
        return run?.status !== "completed" || run.ordinal > lastAnsweredOrdinal;
      };
      const candidates = projection.messages.filter(
        (m) =>
          m.role === "user" &&
          m.scheduledTaskId === undefined &&
          m.senderThreadId === undefined &&
          (m.humanOrigin !== undefined ||
            (m.createdBy === "user" && ["web", "mobile"].includes(m.creationSource))),
      );
      const index =
        input.afterMessageId === undefined
          ? -1
          : candidates.findIndex((m) => m.id === input.afterMessageId);
      if (input.afterMessageId !== undefined && index < 0)
        return yield* new ThreadRecoveryError({
          code: "not_found",
          message: "Pending-human watermark does not belong to this thread.",
        });
      return {
        threadId: input.threadId,
        watermark: candidates.at(-1)?.id ?? null,
        requests: candidates
          .slice(index + 1)
          .filter(isPending)
          .map((m) => ({
            itemId:
              projection.turnItems.find((i) => i.type === "user_message" && i.messageId === m.id)
                ?.id ?? null,
            messageId: m.id,
            runId: m.runId,
            createdAt: DateTime.formatIso(m.createdAt),
            origin: m.humanOrigin ? ("human" as const) : ("unknown" as const),
            principal: m.humanOrigin?.principal ?? null,
            text: m.text,
            attachments: m.attachments,
            disposition: m.humanOrigin ? ("pending" as const) : ("verification-required" as const),
          })),
      } satisfies HumanPendingResult;
    }).pipe(Effect.mapError(failure));
  return PendingHumanRequests.of({
    read,
    listPending: (input) =>
      Effect.gen(function* () {
        const result = yield* read(input);
        const projection = yield* threads.getThreadRecords(input.threadId, ["runs"]);
        return result.requests.map((request) => {
          const status = projection.runs.find((run) => run.id === request.runId)?.status;
          const reason =
            status === "failed"
              ? ("failed" as const)
              : status === "interrupted" || status === "cancelled"
                ? ("interrupted" as const)
                : status === "queued"
                  ? ("queued" as const)
                  : ("unanswered" as const);
          return {
            turnItemId: request.itemId ?? ids.derive.userTurnItem({ messageId: request.messageId }),
            sourceMessageId: request.messageId,
            reason,
          };
        });
      }).pipe(Effect.mapError(failure)),
    resolve: (input) =>
      Effect.gen(function* () {
        const authority = yield* requireAdmin;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const pending = yield* read(input);
            const projection = yield* threads.getThreadRecords(input.threadId, [
              "messages",
              "turnItems",
            ]);
            for (const id of new Set(input.itemIds)) {
              const request = pending.requests.find(
                (r) => (r.itemId ?? ids.derive.userTurnItem({ messageId: r.messageId })) === id,
              );
              if (request) {
                yield* sql`INSERT INTO fork_recovery_human_dispositions(message_id,thread_id,disposition,principal,reference) VALUES(${request.messageId},${input.threadId},'addressed',${authority.principal},${input.reference})`;
                continue;
              }
              const message = projection.messages.find(
                (m) =>
                  (projection.turnItems.find(
                    (i) => i.type === "user_message" && i.messageId === m.id,
                  )?.id ?? ids.derive.userTurnItem({ messageId: m.id })) === id,
              );
              const previous = message
                ? yield* sql<{
                    principal: string;
                    reference: string;
                  }>`SELECT principal,reference FROM fork_recovery_human_dispositions WHERE thread_id=${input.threadId} AND message_id=${message.id} AND disposition='addressed'`
                : [];
              if (
                previous[0]?.principal !== authority.principal ||
                previous[0]?.reference !== input.reference
              )
                return yield* new ThreadRecoveryError({
                  code: "conflict",
                  message:
                    "Only pending human turn items, or retries of the same explicit addressing evidence, can be addressed.",
                });
            }
          }),
        );
        return yield* read(input);
      }).pipe(Effect.mapError(failure)),
  });
});
export const layer = Layer.effect(PendingHumanRequests, make);
