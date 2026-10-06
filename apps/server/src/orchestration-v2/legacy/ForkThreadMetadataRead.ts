import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** Read historical supervision fields only for the sidecar cutover import. */
export const readForkThreadMetadata = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    if (!columns.some((c) => c.name === "parent_thread_id")) return null;
    const rows = yield* sql<{
      thread_id: string;
      parent_thread_id: string | null;
      scope?: string | null;
      remote_parent_json?: string | null;
      settle_on_complete?: number | null;
    }>`SELECT t.* FROM projection_threads t LEFT JOIN fork_thread_metadata m ON m.thread_id = t.thread_id WHERE m.thread_id IS NULL`;
    if (!columns.some((column) => column.name === "settle_on_complete"))
      return { rows, policies: null };
    const policies = yield* sql<{
      thread_id: string;
      settle_on_complete: number | null;
    }>`SELECT thread_id, settle_on_complete FROM projection_threads`;
    return { rows, policies };
  });
