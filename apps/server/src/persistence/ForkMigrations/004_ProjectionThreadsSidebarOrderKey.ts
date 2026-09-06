/**
 * Adds the inbox manual-order column. Kept separate from pin_order_key so a
 * pin/unpin cycle never consumes or clears the position a thread holds in the
 * inbox list.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "sidebar_order_key")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN sidebar_order_key TEXT
    `;
  }
});
