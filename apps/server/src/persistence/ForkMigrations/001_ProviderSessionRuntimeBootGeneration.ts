/**
 * Adds the nullable server boot-generation identity to provider runtime rows.
 *
 * Existing rows remain null so they are recognized as belonging to a dead
 * server generation and can be settled by the session reaper.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "boot_generation_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN boot_generation_id TEXT
    `;
  }
});
