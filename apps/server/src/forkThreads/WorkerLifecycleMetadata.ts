import { hasActiveWork } from "./ArchiveDeadlines.ts";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as SqlClient from "effect/sql/SqlClient";
import { readMetadata } from "./MetadataStore.ts";

/** Re-read only the target worker while its native command is locked. */
export const readWorkerMetadata = readMetadata;

/** Sidecar supervision and native existence must agree at the settlement boundary. */
export const hasLiveChildren = <E, R>(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  getShell: (id: ThreadId) => Effect.Effect<OrchestrationV2ThreadShell | null, E, R>,
) =>
  Effect.gen(function* () {
    // Native V2 can run without the fork metadata layer (including replay harnesses).
    const tables =
      yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fork_thread_metadata'`;
    if (tables.length === 0) return false;
    const rows = yield* sql<{ thread_id: string }>`WITH RECURSIVE children(thread_id) AS (
      SELECT thread_id FROM fork_thread_metadata WHERE json_extract(payload, '$.parentThreadId') = ${threadId}
      UNION
      SELECT m.thread_id FROM fork_thread_metadata m JOIN children c
        ON json_extract(m.payload, '$.parentThreadId') = c.thread_id
    ) SELECT thread_id FROM children`;
    for (const row of rows) {
      const child = yield* getShell(ThreadId.make(row.thread_id));
      if (
        child &&
        child.deletedAt === null &&
        (hasActiveWork(child) || (child.archivedAt === null && child.settledOverride !== "settled"))
      )
        return true;
    }
    return false;
  });
