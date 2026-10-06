import { ForkThreadMetadata, ForkRemoteParent, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import { readForkThreadMetadata } from "../orchestration-v2/legacy/ForkThreadMetadataRead.ts";

export const metadataJson = Schema.fromJsonString(ForkThreadMetadata);
const decodeMetadata = Schema.decodeUnknownEffect(metadataJson);
const encodeMetadata = Schema.encodeEffect(metadataJson);
const decodeRemoteParent = Schema.decodeUnknownEffect(Schema.fromJsonString(ForkRemoteParent));
/** Import once, including null/missing parents. Existing V2 edits win on every restart. */
export const initializeMetadata = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_metadata (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_metadata_receipts (command_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
    const legacy = yield* readForkThreadMetadata(sql);
    if (legacy === null) return;
    const { rows, policies } = legacy;
    for (const row of rows) {
      const metadata: ForkThreadMetadata = {
        threadId: ThreadId.make(row.thread_id),
        parentThreadId: row.parent_thread_id === null ? null : ThreadId.make(row.parent_thread_id),
        ...(row.scope !== undefined ? { scope: row.scope } : {}),
        ...(row.settle_on_complete !== undefined
          ? {
              settleOnComplete:
                row.settle_on_complete === null ? null : row.settle_on_complete === 1,
            }
          : {}),
      };
      if (row.remote_parent_json) {
        const remoteParent = yield* decodeRemoteParent(row.remote_parent_json);
        Object.assign(metadata, { remoteParent });
      }
      const payload = yield* encodeMetadata(metadata);
      yield* sql`INSERT OR IGNORE INTO fork_thread_metadata (thread_id, payload) VALUES (${row.thread_id}, ${payload})`;
    }
    // Older sidecar rows predate lifecycle policy; explicit V2 values (including null) win.
    if (policies !== null) {
      const existing = yield* listMetadata(sql);
      const byId = new Map(existing.map((row) => [String(row.threadId), row]));
      for (const row of policies) {
        const metadata = byId.get(row.thread_id);
        if (metadata && metadata.settleOnComplete === undefined) {
          yield* writeMetadata(sql, {
            ...metadata,
            settleOnComplete: row.settle_on_complete === null ? null : row.settle_on_complete === 1,
          });
        }
      }
    }
  });
export const listMetadata = (sql: SqlClient.SqlClient) =>
  sql<{ payload: string }>`SELECT payload FROM fork_thread_metadata ORDER BY thread_id`.pipe(
    Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeMetadata(row.payload))),
  );
/** Seed delegation ownership in the creation transaction; later organizational edits always win. */
export const seedDelegatedMetadata = (
  sql: SqlClient.SqlClient,
  child: ThreadId,
  parent: ThreadId,
) =>
  Effect.gen(function* () {
    const value: ForkThreadMetadata = {
      threadId: child,
      parentThreadId: parent,
      remoteParent: null,
      subproject: "off",
      settleOnComplete: true,
    };
    const payload = yield* encodeMetadata(value);
    yield* sql`INSERT OR IGNORE INTO fork_thread_metadata (thread_id, payload) VALUES (${child}, ${payload})`;
  });
/** Organizational readback is indexed by the same opaque ID as native thread shells. */
export const readMetadata = (sql: SqlClient.SqlClient, threadId: ThreadId) =>
  sql<{
    payload: string;
  }>`SELECT payload FROM fork_thread_metadata WHERE thread_id = ${threadId}`.pipe(
    Effect.flatMap((rows) =>
      rows[0] ? decodeMetadata(rows[0].payload) : Effect.succeed(undefined),
    ),
  );
export const writeMetadata = (sql: SqlClient.SqlClient, value: ForkThreadMetadata) =>
  Effect.gen(function* () {
    const payload = yield* encodeMetadata(value);
    yield* sql`INSERT INTO fork_thread_metadata (thread_id, payload) VALUES (${value.threadId}, ${payload}) ON CONFLICT(thread_id) DO UPDATE SET payload = excluded.payload`;
  });
