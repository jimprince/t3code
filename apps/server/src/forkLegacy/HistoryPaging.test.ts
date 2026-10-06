import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { ThreadId } from "@t3tools/contracts";
import {
  legacyHistoryTables,
  readForkHistory,
} from "../orchestration-v2/legacy/ForkHistoryRead.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
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

it.effect("pages each legacy table deterministically, including timestamp ties", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA reverse_unordered_selects = ON`;
    for (const [key, table] of Object.entries(legacyHistoryTables)) {
      for (const timestamped of [false, true]) {
        yield* sql.unsafe(`DROP TABLE IF EXISTS ${table}`);
        yield* sql.unsafe(
          `CREATE TABLE ${table} (thread_id TEXT, evidence TEXT, sequence INTEGER${timestamped ? ", created_at TEXT" : ""})`,
        );
        for (let index = 0; index < 7; index++) {
          yield* sql.unsafe(`INSERT INTO ${table} VALUES (?, ?, ?${timestamped ? ", ?" : ""})`, [
            "ordered-history",
            String(index),
            index,
            ...(timestamped ? ["2026-01-01T00:00:00Z"] : []),
          ]);
        }
        const history = yield* openHistory(
          sql,
          "ordered-history",
          {},
          {
            thread: [],
            messages: [],
            turns: [],
            diffs: [],
            tools: [],
            plans: [],
            goals: [],
            events: [],
            provenance: [],
          },
        );
        const section =
          key === "legacyThreads"
            ? "thread"
            : key === "legacyMessages"
              ? "messages"
              : key === "legacyActivities"
                ? "tools"
                : key === "legacyDiffs"
                  ? "diffs"
                  : key === "legacyPlans"
                    ? "plans"
                    : key === "legacyGoals"
                      ? "goals"
                      : key === "legacyEvents"
                        ? "events"
                        : "turns";
        const evidence: unknown[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page: Effect.Success<ReturnType<typeof history.page>> = yield* history.page(
            section,
            offset,
            2,
          );
          evidence.push(...page.records.map((row) => row.evidence));
          offset = page.nextOffset;
        }
        assert.deepStrictEqual(
          evidence,
          ["0", "1", "2", "3", "4", "5", "6"],
          `${table}: every row once in stable order`,
        );
        yield* sql.unsafe(`DROP TABLE ${table}`);
      }
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("seeks the thread for legacy event probes, counts, pages and transfer reads", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP TABLE orchestration_events`;
    yield* sql`CREATE TABLE orchestration_events (
      sequence INTEGER PRIMARY KEY, aggregate_kind TEXT, stream_id TEXT,
      application_event_version INTEGER, payload_json TEXT
    )`;
    yield* sql`CREATE INDEX idx_orch_events_stream_sequence
      ON orchestration_events(aggregate_kind, stream_id, sequence)`;
    yield* sql`CREATE INDEX idx_orchestration_events_application_sequence
      ON orchestration_events(application_event_version, sequence)`;
    yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000)
      INSERT INTO orchestration_events
      SELECT i, 'thread', 'unrelated-' || i, 1, 'unrelated' FROM n`;
    yield* sql`INSERT INTO orchestration_events VALUES
      (2001, 'thread', 'target', 1, 'first'),
      (2002, 'thread', 'target', 2, 'native'),
      (2003, 'thread', 'target', 1, 'second'),
      (2004, 'project', 'target', 1, 'project')`;
    const baseline = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT 1 FROM orchestration_events
      WHERE stream_id = 'absent' AND application_event_version = 1 LIMIT 1`;
    assert.isTrue(baseline.some(({ detail }) => detail.includes("application_event_version=?")));
    let eventReads = 0;
    const bounded = {
      unsafe: ((statement: string, params?: ReadonlyArray<string | number>) =>
        Effect.gen(function* () {
          if (statement.startsWith("SELECT") && statement.includes("FROM orchestration_events")) {
            const plan = yield* sql.unsafe<{ detail: string }>(
              `EXPLAIN QUERY PLAN ${statement}`,
              params,
            );
            assert.match(
              plan.map((row) => row.detail).join("\n"),
              /stream_id=\?/,
              "legacy event reads must seek the thread instead of scanning all V1 events",
            );
            const details = plan.map((row) => row.detail).join("\n");
            assert.notInclude(
              details,
              "SCAN",
              "an empty thread must not scan unrelated legacy history",
            );
            assert.notInclude(
              details,
              "TEMP B-TREE",
              "pages must use the stream index's sequence order",
            );
            eventReads++;
          }
          return yield* sql.unsafe(statement, params);
        })) as Parameters<typeof openHistory>[0]["unsafe"],
    };
    const history = yield* open(bounded, "target");
    assert.deepStrictEqual(history.sections, ["events"]);
    const first = yield* history.page("events", 0, 1);
    assert.deepStrictEqual(
      first.records.map((row) => row.payload_json),
      ["first"],
    );
    assert.equal(first.nextOffset, 1);
    const second = yield* history.page("events", 1, 1);
    assert.deepStrictEqual(
      second.records.map((row) => row.payload_json),
      ["second"],
    );
    assert.equal(second.nextOffset, null);
    const absent = yield* open(bounded, "absent");
    assert.deepStrictEqual(absent.sections, []);
    const transferred = yield* readForkHistory(bounded as typeof sql, ThreadId.make("target"));
    assert.deepStrictEqual(
      (transferred.legacyEvents as Array<{ payload_json: string }>).map((row) => row.payload_json),
      ["first", "second"],
    );
    assert.isAtLeast(eventReads, 6);
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("reads pre-version and sparse retained event schemas", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY, stream_id TEXT, payload_json TEXT)`;
    yield* sql`INSERT INTO orchestration_events VALUES (1, 'old', 'retained')`;
    const history = yield* openHistory(sql, "old", {}, historySections({}));
    assert.deepStrictEqual((yield* history.page("events", 0, 10)).records, [
      { sequence: 1, stream_id: "old", payload_json: "retained" },
    ]);
    assert.deepStrictEqual((yield* readForkHistory(sql, ThreadId.make("old"))).legacyEvents, [
      { sequence: 1, stream_id: "old", payload_json: "retained" },
    ]);
    yield* sql`ALTER TABLE orchestration_events ADD COLUMN aggregate_kind TEXT DEFAULT 'thread'`;
    const sparse = yield* openHistory(sql, "old", {}, historySections({}));
    assert.equal((yield* sparse.page("events", 0, 10)).records.length, 1);
    assert.equal(
      ((yield* readForkHistory(sql, ThreadId.make("old"))).legacyEvents as unknown[]).length,
      1,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
