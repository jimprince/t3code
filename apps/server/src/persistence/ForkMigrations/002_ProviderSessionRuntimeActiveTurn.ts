/**
 * Promotes the currently active provider turn out of the opaque runtime
 * payload so lifecycle updates can use compare-and-set semantics.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(provider_session_runtime)
  `;
  if (!columns.some((column) => column.name === "active_turn_id")) {
    yield* sql`
      ALTER TABLE provider_session_runtime
      ADD COLUMN active_turn_id TEXT
    `;
  }

  yield* sql`
    UPDATE provider_session_runtime
    SET active_turn_id = json_extract(runtime_payload_json, '$.activeTurnId')
    WHERE active_turn_id IS NULL
      AND CASE
        WHEN json_valid(runtime_payload_json)
        THEN json_type(runtime_payload_json, '$.activeTurnId')
        ELSE NULL
      END = 'text'
  `;
});
