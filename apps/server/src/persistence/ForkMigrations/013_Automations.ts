import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Plain tables for scripts and automation rules; see apps/server/src/automations. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_scripts (
      script_id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      script_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_automation_scripts_scope_name
    ON automation_scripts(COALESCE(project_id, ''), name)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS automations (
      automation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      automation_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      status TEXT NOT NULL,
      run_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (automation_id, dedupe_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_active
    ON automation_runs(status) WHERE status IN ('queued', 'running')
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_automation_runs_automation
    ON automation_runs(automation_id, created_at)
  `;
});
