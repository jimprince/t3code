import type { LegacyHistorySection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as SqlError from "effect/unstable/sql/SqlError";
import {
  legacyEventWhere,
  legacyHistoryTables,
} from "../orchestration-v2/legacy/ForkHistoryRead.ts";

type Row = Record<string, unknown>;
type Db = {
  readonly unsafe: <A extends object = Row>(
    sql: string,
    params?: ReadonlyArray<string | number>,
  ) => Effect.Effect<ReadonlyArray<A>, SqlError.SqlError>;
};
type LegacyKey = keyof typeof legacyHistoryTables;

/** One run of historical rows. Table-backed sources never load more than a page. */
interface RowSource {
  readonly exists: Effect.Effect<boolean, SqlError.SqlError>;
  readonly count: Effect.Effect<number, SqlError.SqlError>;
  readonly page: (
    offset: number,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>;
}

const legacyHistoryKeys = Object.keys(legacyHistoryTables) as ReadonlyArray<LegacyKey>;
const sectionOrder: ReadonlyArray<LegacyHistorySection> = [
  "thread",
  "messages",
  "turns",
  "diffs",
  "tools",
  "plans",
  "goals",
  "events",
  "provenance",
];
const historicalPayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const records = (value: unknown): ReadonlyArray<Row> =>
  Array.isArray(value) ? value.filter(Predicate.isObject) : [];

const goalOf = (thread: Row): Row => ({ threadId: thread.thread_id, goalJson: thread.goal_json });
const hasGoal = (thread: Row) => thread.goal_json !== undefined && thread.goal_json !== null;
const forkedOf = (activity: Row): Row => {
  const decoded =
    typeof activity.payload_json === "string"
      ? historicalPayload(activity.payload_json)
      : Option.none();
  return {
    activityId: activity.activity_id,
    kind: activity.kind,
    payload: Option.isSome(decoded) ? decoded.value : activity.payload_json,
  };
};
const isForked = (activity: Row) => activity.kind === "thread.forked";

const memorySource = (rows: ReadonlyArray<Row>): RowSource => ({
  exists: Effect.succeed(rows.length > 0),
  count: Effect.succeed(rows.length),
  page: (offset, limit) => Effect.succeed(rows.slice(offset, offset + limit)),
});

/** Fixed historical tables only; the thread filter is always a bound parameter. */
const tableSource = Effect.fn("HistoryPaging.tableSource")(function* (
  db: Db,
  key: LegacyKey,
  threadId: string,
  narrow?: { readonly column: string; readonly sql: string; readonly map: (row: Row) => Row },
) {
  const table = legacyHistoryTables[key];
  const columns = (yield* db.unsafe<{ name: string }>(`PRAGMA table_info(${table})`)).map(
    (column) => column.name,
  );
  const extra = narrow === undefined ? "" : ` AND ${narrow.sql}`;
  const where = columns.includes("thread_id")
    ? `thread_id = ?${extra}`
    : table === "orchestration_events" && columns.includes("stream_id")
      ? `${legacyEventWhere(columns)}${extra}`
      : null;
  if (where === null || (narrow !== undefined && !columns.includes(narrow.column))) {
    return memorySource([]);
  }
  const order =
    table === "orchestration_events"
      ? " ORDER BY sequence"
      : columns.includes("created_at")
        ? " ORDER BY created_at, rowid"
        : " ORDER BY rowid";
  const map = narrow?.map ?? ((row: Row) => row);
  return {
    exists: db
      .unsafe(`SELECT 1 AS present FROM ${table} WHERE ${where} LIMIT 1`, [threadId])
      .pipe(Effect.map((rows) => rows.length > 0)),
    count: db
      .unsafe<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, [threadId])
      .pipe(Effect.map((rows) => Number(rows[0]?.n ?? 0))),
    page: (offset, limit) =>
      db
        .unsafe<Row>(`SELECT * FROM ${table} WHERE ${where}${order} LIMIT ? OFFSET ?`, [
          threadId,
          limit,
          offset,
        ])
        .pipe(Effect.map((rows) => rows.map(map))),
  } satisfies RowSource;
});

const pageOf = Effect.fn("HistoryPaging.pageOf")(function* (
  sources: ReadonlyArray<RowSource>,
  offset: number,
  limit: number,
) {
  const rows: Array<Row> = [];
  const need = limit + 1;
  let skip = offset;
  for (const source of sources) {
    if (skip > 0) {
      const size = yield* source.count;
      if (skip >= size) {
        skip -= size;
        continue;
      }
    }
    rows.push(...(yield* source.page(skip, need - rows.length)));
    skip = 0;
    if (rows.length >= need) break;
  }
  return {
    records: rows.slice(0, limit),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
});

/**
 * Reads historical evidence page by page. `extras` are the sections derived from the
 * transferred payload without its legacy table copies; those stay in memory (one row).
 */
export const openHistory = Effect.fn("HistoryPaging.openHistory")(function* (
  db: Db,
  threadId: string,
  transferred: Row,
  extras: Readonly<Record<LegacyHistorySection, ReadonlyArray<Row>>>,
) {
  const tables = {} as Record<LegacyKey, boolean>;
  const primary = {} as Record<LegacyKey, RowSource>;
  for (const key of legacyHistoryKeys) {
    const table = yield* tableSource(db, key, threadId);
    tables[key] = yield* table.exists;
    primary[key] = tables[key] ? table : memorySource(records(transferred[key]));
  }
  const goals = tables.legacyThreads
    ? yield* tableSource(db, "legacyThreads", threadId, {
        column: "goal_json",
        sql: "goal_json IS NOT NULL",
        map: goalOf,
      })
    : memorySource(records(transferred.legacyThreads).filter(hasGoal).map(goalOf));
  const forks = tables.legacyActivities
    ? yield* tableSource(db, "legacyActivities", threadId, {
        column: "kind",
        sql: "kind = 'thread.forked'",
        map: forkedOf,
      })
    : memorySource(records(transferred.legacyActivities).filter(isForked).map(forkedOf));
  const sources: Record<LegacyHistorySection, ReadonlyArray<RowSource>> = {
    thread: [primary.legacyThreads, memorySource(extras.thread)],
    messages: [primary.legacyMessages, memorySource(extras.messages)],
    turns: [
      primary.legacyTurns,
      primary.legacyThreadCheckpoints,
      primary.legacyCheckpoints,
      memorySource(extras.turns),
    ],
    diffs: [primary.legacyDiffs, memorySource(extras.diffs)],
    tools: [primary.legacyActivities, memorySource(extras.tools)],
    plans: [primary.legacyPlans, memorySource(extras.plans)],
    goals: [primary.legacyGoals, goals, memorySource(extras.goals)],
    events: [primary.legacyEvents, memorySource(extras.events)],
    provenance: [forks, memorySource(extras.provenance)],
  };
  const present: Array<LegacyHistorySection> = [];
  for (const section of sectionOrder) {
    for (const source of sources[section]) {
      if (yield* source.exists) {
        present.push(section);
        break;
      }
    }
  }
  return {
    sections: present,
    /** True when V1 rows or a V1 bundle back this thread, not only a native transfer snapshot. */
    v1Origin:
      legacyHistoryKeys.some((key) => tables[key] || records(transferred[key]).length > 0) ||
      Predicate.isObject(transferred.legacyBundle) ||
      records(transferred.previousTransfers).some((prior) =>
        Predicate.isObject(prior.legacyBundle),
      ),
    page: (section: LegacyHistorySection, offset: number, limit: number) =>
      pageOf(sources[section], offset, limit),
  };
});

export const withoutLegacyKeys = (transferred: Row): Row =>
  Object.fromEntries(Object.entries(transferred).filter(([key]) => !(key in legacyHistoryTables)));
