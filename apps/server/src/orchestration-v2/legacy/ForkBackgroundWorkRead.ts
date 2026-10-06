import type * as SqlClient from "effect/unstable/sql/SqlClient";

/** Historical tasks eligible for the one-time native recovery notice. */
export function readForkBackgroundWork(sql: SqlClient.SqlClient) {
  return sql<{ thread_id: string; tasks_json: string; updated_at: string }>`
      SELECT work.thread_id, work.tasks_json, work.updated_at FROM fork_thread_background_work work
      LEFT JOIN projection_thread_sessions session ON session.thread_id = work.thread_id
      LEFT JOIN projection_threads thread ON thread.thread_id = work.thread_id
      LEFT JOIN projection_turns turn ON turn.thread_id = thread.thread_id AND turn.turn_id = thread.latest_turn_id
      WHERE COALESCE(session.status, '') NOT IN ('stopped', 'interrupted', 'error')
        AND COALESCE(turn.state, '') NOT IN ('interrupted', 'error')
    `;
}
