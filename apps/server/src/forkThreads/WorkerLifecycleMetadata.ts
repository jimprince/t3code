import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { metadataJson } from "./MetadataStore.ts";

const decode = Schema.decodeUnknownEffect(metadataJson);
/** Re-read only the target worker while its native command is locked. */
export const readWorkerMetadata = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ payload: string }>`SELECT payload FROM fork_thread_metadata WHERE thread_id = ${threadId}`;
    return rows[0] ? yield* decode(rows[0].payload) : undefined;
  });
