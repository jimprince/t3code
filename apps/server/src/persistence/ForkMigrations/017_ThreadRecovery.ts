import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_recovery_generations (thread_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_recovery_operations (operation_id TEXT PRIMARY KEY, principal TEXT NOT NULL, fingerprint TEXT NOT NULL, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_recovery_session_fences (session_id TEXT NOT NULL, thread_id TEXT NOT NULL, operation_id TEXT NOT NULL, run_ordinal INTEGER NOT NULL, PRIMARY KEY(session_id,thread_id))`;
  yield* sql`CREATE INDEX IF NOT EXISTS fork_recovery_session_fences_thread ON fork_recovery_session_fences(thread_id)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_recovery_thread_fences (thread_id TEXT PRIMARY KEY, successor_thread_id TEXT NOT NULL, operation_id TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_recovery_human_dispositions (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, disposition TEXT NOT NULL, principal TEXT NOT NULL, reference TEXT NOT NULL)`;
  yield* sql`CREATE INDEX IF NOT EXISTS fork_recovery_human_dispositions_thread ON fork_recovery_human_dispositions(thread_id)`;
});
