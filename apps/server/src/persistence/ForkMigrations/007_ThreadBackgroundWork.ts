/**
 * Remembers each thread's live background work so the next server start can
 * resume it (fork-resume-background-work). Rows are transient: startup
 * consumes and deletes them.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS fork_thread_background_work (
      thread_id TEXT PRIMARY KEY,
      tasks_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
