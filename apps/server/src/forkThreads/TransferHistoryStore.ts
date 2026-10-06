import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadId } from "@t3tools/contracts";
const json = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
export const initializeTransferHistory = (sql: SqlClient.SqlClient) =>
  sql`CREATE TABLE IF NOT EXISTS fork_transferred_history (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
export const readTransferHistory = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{
    payload: string;
  }>`SELECT payload FROM fork_transferred_history WHERE thread_id = ${threadId}`.pipe(
    Effect.flatMap((rows) =>
      rows[0]
        ? Schema.decodeUnknownEffect(json)(rows[0].payload)
        : Effect.succeed<Record<string, unknown>>({}),
    ),
  );
export const writeTransferHistory = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  payload: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(json)(payload);
    yield* sql`INSERT INTO fork_transferred_history VALUES (${threadId}, ${encoded}) ON CONFLICT(thread_id) DO UPDATE SET payload = excluded.payload`;
  });
