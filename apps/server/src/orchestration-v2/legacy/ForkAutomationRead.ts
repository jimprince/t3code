import type { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Read an imported action's exact historical input; never dispatch or modify V1 state. */
export function readLegacyAutomationOutcome(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
) {
  return sql<{
    turn_id: string | null;
    latest_turn_id: string | null;
    state: string | null;
    checkpoint_turn_count: number | null;
    checkpoint_status: string | null;
    session_status: string | null;
    last_error: string | null;
  }>`SELECT message.turn_id, thread.latest_turn_id, turn.state, turn.checkpoint_turn_count,
      turn.checkpoint_status, session.status AS session_status, session.last_error
    FROM projection_thread_messages message
    JOIN projection_threads thread ON thread.thread_id=message.thread_id
    LEFT JOIN projection_turns turn ON turn.thread_id=message.thread_id AND turn.turn_id=message.turn_id
    LEFT JOIN projection_thread_sessions session ON session.thread_id=message.thread_id
    WHERE message.thread_id=${threadId} AND message.message_id=${messageId} AND message.role='user'`.pipe(
    Effect.map((rows): { status: "completed" | "failed"; result: string } | null => {
      const row = rows[0];
      if (!row) return null;
      if (
        row.turn_id !== null &&
        row.turn_id === row.latest_turn_id &&
        row.state !== null &&
        row.state !== "running"
      )
        return row.state === "completed"
          ? { status: "completed", result: "Turn completed." }
          : { status: "failed", result: `Turn ${row.state}.` };
      if (
        row.turn_id !== null &&
        row.turn_id !== row.latest_turn_id &&
        row.checkpoint_turn_count !== null
      )
        return row.checkpoint_status === "error"
          ? { status: "failed", result: "Turn checkpoint failed." }
          : { status: "completed", result: "Turn completed." };
      if (row.session_status === "error" || row.session_status === "stopped")
        return {
          status: "failed",
          result: row.last_error ?? "Provider session stopped before completion.",
        };
      return null;
    }),
  );
}
