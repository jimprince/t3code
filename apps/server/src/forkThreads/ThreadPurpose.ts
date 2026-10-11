import { effectivePurpose } from "@t3tools/client-runtime/state/thread-purpose";
import {
  ThreadId,
  type ThreadPurpose,
  type ForkThreadMetadata,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import { listMetadata, metadataJson } from "./MetadataStore.ts";

/** Resolve a creator even when its own row is absent. Remote ancestry is unknown locally. */
export const resolveCreatorPurpose = <E = never, R = never>(
  sql: SqlClient.SqlClient,
  creator: ThreadId,
  getShell?: (
    id: ThreadId,
  ) => Effect.Effect<Pick<OrchestrationV2ThreadShell, "lineage"> | null, E, R>,
) =>
  Effect.gen(function* () {
    const rows = yield* listMetadata(sql);
    const nodes = rows.map((row) => ({
      key: row.threadId,
      parentKey: row.remoteParent
        ? `remote:${row.remoteParent.environmentId}:${row.remoteParent.threadId}`
        : row.parentThreadId,
      purpose: row.purpose,
      unavailable: false,
    }));
    const metadata = new Map(rows.map((row) => [row.threadId, row]));
    const seen = new Set<ThreadId>();
    let cursor: ThreadId | null = creator;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const row = metadata.get(cursor);
      if (row !== undefined) {
        if (row.purpose != null || row.remoteParent != null) break;
        cursor = row.parentThreadId;
        continue;
      }
      const shell = getShell === undefined ? null : yield* getShell(cursor);
      const parent: ThreadId | null =
        shell?.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null;
      nodes.push({
        key: cursor,
        parentKey: parent,
        purpose: undefined,
        unavailable: getShell !== undefined && shell === null,
      });
      cursor = parent;
    }
    return effectivePurpose(nodes).get(creator) ?? null;
  });

/** Creation-transaction seed. Replay and later user edits always keep the existing row. */
export const seedPurposeMetadata = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  purpose: ThreadPurpose,
) =>
  Effect.gen(function* () {
    const value: ForkThreadMetadata = { threadId, parentThreadId: null, purpose };
    const payload = yield* Schema.encodeEffect(metadataJson)(value);
    yield* sql`INSERT OR IGNORE INTO fork_thread_metadata (thread_id, payload) VALUES (${threadId}, ${payload})`;
  });
