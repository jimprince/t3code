import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { historySections } from "./HistoryReader.ts";
import { openHistory, withoutLegacyKeys } from "./HistoryPaging.ts";

const open = (
  db: Parameters<typeof openHistory>[0],
  threadId: string,
  transferred: Record<string, unknown> = {},
) => openHistory(db, threadId, transferred, historySections(withoutLegacyKeys(transferred)));

it.effect("probes and pages legacy rows without reading the whole history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO projection_thread_messages
        (message_id, thread_id, role, text, is_streaming, created_at, updated_at)
      SELECT 'm' || i, 'legacy', 'user', 'text ' || i, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
      FROM n`;
    yield* sql`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 300)
      INSERT INTO checkpoint_diff_blobs (thread_id, from_turn_count, to_turn_count, diff, created_at)
      SELECT 'legacy', i, i + 1, 'diff ' || i, '2026-01-01T00:00:00Z' FROM n`;
    let dataRows = 0;
    const counted = {
      unsafe: ((statement: string, params?: ReadonlyArray<string | number>) =>
        Effect.gen(function* () {
          const rows = yield* sql.unsafe(statement, params);
          if (!statement.startsWith("PRAGMA")) dataRows += rows.length;
          return rows;
        })) as Parameters<typeof openHistory>[0]["unsafe"],
    };

    const history = yield* open(counted, "legacy");
    assert.deepStrictEqual(history.sections, ["messages", "diffs"]);
    assert.isAtMost(dataRows, 10, "the probe reads one existence row per table at most");

    dataRows = 0;
    const first = yield* history.page("messages", 0, 10);
    assert.equal(first.records.length, 10);
    assert.equal(first.nextOffset, 10);
    assert.isAtMost(dataRows, 11);

    const last = yield* history.page("messages", 295, 10);
    assert.equal(last.records.length, 5);
    assert.equal(last.nextOffset, null);
    const exact = yield* history.page("diffs", 290, 10);
    assert.equal(exact.records.length, 10);
    assert.equal(exact.nextOffset, null);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reports V1 origin only when V1 rows or a V1 bundle back the history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const v1Origin = (transferred: Record<string, unknown>) =>
      open(sql, "elsewhere", transferred).pipe(Effect.map((history) => history.v1Origin));
    const native = { nativeProjection: { messages: [{ id: "native" }] } };
    assert.isFalse(yield* v1Origin(native));
    assert.isFalse(yield* v1Origin({ ...native, legacyBundle: null }));
    assert.isTrue(yield* v1Origin({ ...native, legacyBundle: { version: 2, thread: {} } }));
    assert.isTrue(yield* v1Origin({ ...native, legacyMessages: [{ message_id: "m" }] }));
    assert.isTrue(
      yield* v1Origin({ previousTransfers: [{ legacyBundle: { version: 2, thread: {} } }] }),
    );
    const moved = yield* open(sql, "elsewhere", native);
    assert.deepStrictEqual(moved.sections, ["messages", "provenance"]);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
