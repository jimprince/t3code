/**
 * Adds a dedicated column for chat file attachments. Kept separate from
 * attachments_json so the ChatAttachment union that old readers decode is
 * never widened with a "file" member.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;
  if (!columns.some((column) => column.name === "file_attachments_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN file_attachments_json TEXT
    `;
  }
});
