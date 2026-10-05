import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_thread_issues (
      thread_id TEXT NOT NULL,
      host TEXT NOT NULL,
      repository TEXT NOT NULL,
      number INTEGER NOT NULL,
      url TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      PRIMARY KEY (thread_id, host, repository, number)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_thread_issues_issue
    ON projection_thread_issues(host, repository, number)
  `;
});
