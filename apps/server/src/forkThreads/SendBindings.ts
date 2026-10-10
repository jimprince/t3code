import {
  CommandId,
  MessageId,
  RunId,
  HandoffError,
  type SendBindingInput,
  type SendBindingResult,
  type SendRunBinding,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

/** Native MCP send associations commit with the message, run and outbox. */
export class SendBindingWrite extends Context.Reference<{
  commandId: CommandId;
  persist: Effect.Effect<void, SqlError>;
} | null>("fork/SendBindingWrite", { defaultValue: () => null }) {}
const exactPart = (value: string) => encodeURIComponent(value).replaceAll("*", "%2A");
const prefix = (input: SendBindingInput) =>
  `send-binding:${exactPart(input.threadId)}:${exactPart(input.sendId)}:`;
export const recordSendBinding = (
  sql: SqlClient.SqlClient,
  input: SendBindingInput & { namespace: string; messageId: MessageId },
) =>
  sql`INSERT INTO fork_thread_metadata_receipts (command_id,payload) VALUES (${prefix(input) + exactPart(input.namespace)},${JSON.stringify({ messageId: input.messageId })}) ON CONFLICT(command_id) DO NOTHING`.pipe(
    Effect.asVoid,
  );

/** Exact indexed message/run join. The projection, rather than send status, owns run lifecycle. */
export const readMessageRun = (sql: SqlClient.SqlClient, threadId: string, messageId: string) =>
  sql<{
    run_id: string;
    initial_message: string;
    input_intent: string | null;
    status: string;
    queue_held: number | null;
    requested_at: string;
    started_at: string | null;
    completed_at: string | null;
  }>`SELECT (SELECT json_extract(i.payload_json,'$.inputIntent') FROM orchestration_v2_projection_turn_items i WHERE i.run_id=r.run_id AND i.type='user_message' AND json_extract(i.payload_json,'$.messageId')=m.message_id LIMIT 1) AS input_intent,r.run_id,json_extract(r.payload_json,'$.userMessageId') AS initial_message,r.status,json_extract(r.payload_json,'$.queueHeld') AS queue_held,json_extract(r.payload_json,'$.requestedAt') AS requested_at,json_extract(r.payload_json,'$.startedAt') AS started_at,json_extract(r.payload_json,'$.completedAt') AS completed_at FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_runs r ON r.run_id=json_extract(m.payload_json,'$.runId') WHERE m.message_id=${messageId} AND m.thread_id=${threadId} LIMIT 1`.pipe(
    Effect.map((rows) => {
      const row = rows[0];
      if (!row) return null;
      const run = {
        runId: RunId.make(row.run_id),
        status: row.status,
        terminal: ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
          row.status,
        ),
        queueHeld: row.queue_held === 1,
        requestedAt: row.requested_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
      } satisfies SendRunBinding;
      // Steering can replace run.userMessageId while retaining the run. The
      // persisted input intent keeps each send's original delivery identity.
      const initialMessage = row.input_intent
        ? ["turn_start", "queued_turn"].includes(row.input_intent)
          ? messageId
          : null
        : row.initial_message;
      return { run, initialMessage };
    }),
  );

/** Standard thread read: no waking, retries, provider calls or transcript hydration. */
export const makeSendBindingReader = (sql: SqlClient.SqlClient) => ({
  read: (input: SendBindingInput) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const empty = {
            ...input,
            state: "unknown",
            delivery: null,
            runId: null,
            run: null,
          } satisfies SendBindingResult;
          const handoffs = yield* sql<{
            delivery: string;
          }>`SELECT json_extract(payload,'$.receipt.status') AS delivery FROM fork_thread_metadata_receipts WHERE command_id=${`handoff:${input.sendId}`} AND json_extract(payload,'$.receipt.recipientThreadId')=${input.threadId} LIMIT 1`;
          const native = yield* sql<{
            message_id: string;
          }>`SELECT json_extract(payload,'$.messageId') AS message_id FROM fork_thread_metadata_receipts WHERE command_id GLOB ${prefix(input) + "*"} LIMIT 2`;
          const messages = [
            ...(handoffs.length ? [`handoff:${input.sendId}:message`] : []),
            ...native.map((r) => r.message_id),
          ];
          if (messages.length > 1)
            return { ...empty, state: "multiple" } satisfies SendBindingResult;
          if (!messages[0]) return empty;
          const binding = yield* readMessageRun(sql, input.threadId, messages[0]);
          if (!binding)
            return {
              ...empty,
              state: "pending",
              delivery: handoffs[0]?.delivery ?? "queued",
            } satisfies SendBindingResult;
          return {
            ...empty,
            state: "bound",
            delivery:
              binding.run.status === "queued"
                ? "queued"
                : binding.initialMessage === messages[0]
                  ? "started"
                  : "steered",
            runId: binding.run.runId,
            run: binding.run,
          } satisfies SendBindingResult;
        }),
      )
      .pipe(Effect.mapError(() => new HandoffError({ causeCode: "PERSISTENCE_FAILED" }))),
});
