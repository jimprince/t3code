import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Fixed historical tables only. Never restore these rows into native V2 execution. */
export const legacyHistoryTables = {
  legacyThreads: "projection_threads",
  legacyMessages: "projection_thread_messages",
  legacyTurns: "projection_turns",
  legacyActivities: "projection_thread_activities",
  legacyThreadCheckpoints: "projection_thread_checkpoints",
  legacyCheckpoints: "projection_checkpoints",
  legacyDiffs: "checkpoint_diff_blobs",
  legacyPlans: "projection_thread_proposed_plans",
  legacyGoals: "projection_thread_goals",
  legacyEvents: "orchestration_events",
} as const;
/** Keep event reads on the thread index: the version index scans every old event. */
export const legacyEventWhere = (columns: ReadonlyArray<string>): string =>
  `${columns.includes("aggregate_kind") ? "aggregate_kind = 'thread' AND " : ""}stream_id = ?${columns.includes("application_event_version") ? " AND +application_event_version = 1" : ""}`;

export const readForkHistory = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const history: Record<string, unknown> = {};
    for (const [section, table] of Object.entries(legacyHistoryTables)) {
      const columns = yield* sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`);
      if (columns.some((column) => column.name === "thread_id")) {
        const rows = yield* sql.unsafe(`SELECT * FROM ${table} WHERE thread_id = ?`, [threadId]);
        if (rows.length > 0) history[section] = rows;
      } else if (
        table === "orchestration_events" &&
        columns.some((column) => column.name === "stream_id")
      ) {
        const rows = yield* sql.unsafe(
          `SELECT * FROM ${table} WHERE ${legacyEventWhere(columns.map((column) => column.name))} ORDER BY sequence`,
          [threadId],
        );
        if (rows.length > 0) history[section] = rows;
      }
    }
    return history;
  });
