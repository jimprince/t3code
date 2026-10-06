import { ForkThreadMetadata, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

const decode = Schema.decodeUnknownSync(ForkThreadMetadata);
/** Import once, including null/missing parents. Existing V2 edits win on every restart. */
export const initializeMetadata = (sql: SqlClient.SqlClient) => Effect.gen(function* () {
  yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_metadata (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_metadata_receipts (command_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!columns.some(c => c.name === "parent_thread_id")) return;
  const rows = yield* sql<{ thread_id: string; parent_thread_id: string | null; scope?: string | null }>`SELECT * FROM projection_threads`;
  for (const row of rows) {
    const metadata: ForkThreadMetadata = { threadId: ThreadId.make(row.thread_id), parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id), ...(row.scope !== undefined ? { scope: row.scope } : {}) };
    yield* sql`INSERT OR IGNORE INTO fork_thread_metadata (thread_id, payload) VALUES (${row.thread_id}, ${JSON.stringify(metadata)})`;
  }
});
export const listMetadata = (sql: SqlClient.SqlClient) => sql<{ payload: string }>`SELECT payload FROM fork_thread_metadata ORDER BY thread_id`.pipe(Effect.map(rows => rows.map(row => decode(JSON.parse(row.payload)))));
export const writeMetadata = (sql: SqlClient.SqlClient, value: ForkThreadMetadata) => sql`INSERT INTO fork_thread_metadata (thread_id, payload) VALUES (${value.threadId}, ${JSON.stringify(value)}) ON CONFLICT(thread_id) DO UPDATE SET payload = excluded.payload`;
