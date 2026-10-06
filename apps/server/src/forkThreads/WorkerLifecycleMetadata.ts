import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { metadataJson } from "./MetadataStore.ts";

const decode = Schema.decodeUnknownEffect(metadataJson);
/** Re-read only the target worker while its native command is locked. */
export const readWorkerMetadata = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM fork_thread_metadata WHERE thread_id = ${threadId}`;
    return rows[0] ? yield* decode(rows[0].payload) : undefined;
  });

/** Sidecar supervision and native existence must agree at the settlement boundary. */
export const hasLiveChildren = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    // Native V2 can run without the fork metadata layer (including replay harnesses).
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_thread_metadata'`;
    if (tables.length === 0) return false;
    const rows = yield* sql<{ thread_id: string }>`SELECT t.thread_id
      FROM fork_thread_metadata m
      JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
      WHERE json_extract(m.payload, '$.parentThreadId') = ${threadId}
        AND t.archived_at IS NULL AND t.deleted_at IS NULL
      LIMIT 1`;
    return rows.length > 0;
  });
