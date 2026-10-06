// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { v2Projection } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Events from "../orchestration-v2/EventStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Portable from "../forkThreads/PortableHistory.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as History from "./HistoryReader.ts";

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
const tables = [
  "projection_threads",
  "projection_thread_messages",
  "projection_turns",
  "projection_thread_activities",
  "checkpoint_diff_blobs",
  "orchestration_events",
  "effect_sql_migrations",
  "effect_sql_fork_migrations",
];
const snapshotLegacy = (file: string) => {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    return Object.fromEntries(
      tables.map((table) => {
        const columns = db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => String(row.name));
        const historical =
          table === "orchestration_events" && columns.includes("application_event_version");
        const filter = historical
          ? " WHERE application_event_version = 1"
          : table === "effect_sql_migrations"
            ? " WHERE migration_id <= 60"
            : "";
        const selected = columns
          .filter((column) => column !== "application_event_version")
          .join(", ");
        const rows = db.prepare(`SELECT ${selected} FROM ${table}${filter} ORDER BY rowid`).all();
        return [
          table,
          {
            count: rows.length,
            sha256: NodeCrypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
          },
        ];
      }),
    );
  } finally {
    db.close();
  }
};
const storesFor = <E>(db: Layer.Layer<SqlClient.SqlClient, E>) =>
  Layer.mergeAll(Projections.layer, Events.layer, Receipts.layer).pipe(Layer.provideMerge(db));
const servicesFor = <E>(db: Layer.Layer<SqlClient.SqlClient, E>) => {
  const stores = storesFor(db);
  const persisted = Layer.merge(stores, Sink.layer.pipe(Layer.provide(stores)));
  return Layer.mergeAll(
    persisted,
    Legacy.layer.pipe(Layer.provide(persisted)),
    Portable.layer.pipe(Layer.provide(persisted)),
    History.layer.pipe(
      Layer.provide(
        Layer.merge(persisted, Threads.legacyHistoryLayer.pipe(Layer.provide(persisted))),
      ),
    ),
  );
};

describe.runIf(fixtures !== undefined)("copied shipped legacy history", () => {
  it.effect.each(["null", "absent"])(
    "imports retired sidebar ordering once when the newer key is %s",
    (newerKey) =>
      Effect.gen(function* () {
        const temporary = yield* Effect.tryPromise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-sidebar-fixture-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
        );
        const file = NodePath.join(temporary, "statev2.sqlite");
        yield* Effect.tryPromise(() =>
          NodeFSP.copyFile(NodePath.join(fixtures!, "dev-vm.small.sanitized.sqlite"), file),
        );
        const ids = yield* Effect.tryPromise(async () => {
          const copy = new NodeSqlite.DatabaseSync(file);
          try {
            const ids = copy
              .prepare(
                "SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL ORDER BY thread_id LIMIT 3",
              )
              .all()
              .map((row) => String(row.thread_id));
            copy
              .prepare(
                "UPDATE projection_threads SET active_order_key = NULL, sidebar_order_key = 'a0' WHERE thread_id = ?",
              )
              .run(ids[0]!);
            copy
              .prepare(
                "UPDATE projection_threads SET active_order_key = 'b0', sidebar_order_key = 'a1' WHERE thread_id = ?",
              )
              .run(ids[1]!);
            copy
              .prepare(
                "UPDATE projection_threads SET active_order_key = NULL, sidebar_order_key = NULL WHERE thread_id = ?",
              )
              .run(ids[2]!);
            if (newerKey === "absent")
              copy.exec("ALTER TABLE projection_threads DROP COLUMN active_order_key");
            return ids.map((id) => ThreadId.make(id));
          } finally {
            copy.close();
          }
        });
        const before = snapshotLegacy(file);
        const db = makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
        yield* Effect.gen(function* () {
          const importer = yield* Legacy.LegacyV1ThreadImporter;
          const projections = yield* Projections.ProjectionStoreV2;
          const sink = yield* Sink.EventSinkV2;
          const sql = yield* SqlClient.SqlClient;
          yield* importer.reconcileShells;
          assert.equal(
            (yield* projections.getThreadProjection(ids[0]!)).thread.activeOrderKey,
            "a0",
          );
          assert.equal(
            (yield* projections.getThreadProjection(ids[1]!)).thread.activeOrderKey,
            newerKey === "absent" ? "a1" : "b0",
          );
          assert.equal(
            (yield* projections.getThreadProjection(ids[2]!)).thread.activeOrderKey,
            null,
          );
          // A later native clear must not be undone by another legacy reconciliation.
          const thread = (yield* projections.getThreadProjection(ids[0]!)).thread;
          yield* sink.write({
            events: [
              {
                id: EventId.make("native-clear-sidebar"),
                type: "thread.metadata-updated",
                threadId: thread.id,
                occurredAt: thread.updatedAt,
                payload: { ...thread, activeOrderKey: null },
              },
            ],
          });
          const events = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;
          assert.deepStrictEqual(yield* importer.reconcileShells, {
            importedThreadCount: 0,
            importedMessageCount: 0,
          });
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
            events,
          );
          assert.equal(
            (yield* projections.getThreadProjection(ids[0]!)).thread.activeOrderKey,
            null,
          );
        }).pipe(Effect.provide(servicesFor(db)));
        assert.deepStrictEqual(snapshotLegacy(file), before);
      }),
  );

  it.effect.each(["dev-vm", "local-mbp", "synthetic-edges"])(
    "preserves %s V1 rows, both ledgers and fork provenance on double import",
    (name) =>
      Effect.gen(function* () {
        const temporary = yield* Effect.tryPromise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-history-fixture-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
        );
        const file = NodePath.join(temporary, "statev2.sqlite");
        yield* Effect.tryPromise(() =>
          NodeFSP.copyFile(NodePath.join(fixtures!, `${name}.small.sanitized.sqlite`), file),
        );
        // Add explicit fork/diff evidence on the COPY: shipped small fixtures contain no fork event.
        yield* Effect.tryPromise(async () => {
          const db = new NodeSqlite.DatabaseSync(file);
          try {
            const thread = db
              .prepare(
                "SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL ORDER BY thread_id LIMIT 1",
              )
              .get()!;
            const sourceId = String(thread.thread_id);
            db.prepare(
              "INSERT OR IGNORE INTO projection_thread_activities VALUES (?, ?, NULL, 'info', 'thread.forked', 'Forked from old thread', ?, ?, ?)",
            ).run(
              `fork-evidence-${name}`,
              sourceId,
              '{"sourceThreadId":"historical-source","sourceMessageId":"historical-message","workspaceMode":"current"}',
              "2026-01-01T00:00:00Z",
              999999,
            );
            db.prepare("INSERT OR IGNORE INTO checkpoint_diff_blobs VALUES (?, 0, 1, ?, ?)").run(
              sourceId,
              "diff --git a/evidence b/evidence\n+legacy proof\n",
              "2026-01-01T00:00:00Z",
            );
          } finally {
            db.close();
          }
        });
        const before = snapshotLegacy(file);
        const db = makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* Legacy.LegacyV1ThreadImporter;
          const reader = yield* History.HistoryReader;
          const history = yield* Portable.PortableHistory;
          const projections = yield* Projections.ProjectionStoreV2;
          const main = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          const forkLedger =
            yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
          assert.equal(main.at(-1)?.migration_id, 62);
          assert.equal(forkLedger.at(-1)?.migration_id, 15);
          yield* importer.reconcileShells;
          const ids = yield* sql<{
            thread_id: string;
          }>`SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL ORDER BY thread_id`;
          const id = ThreadId.make(ids[0]!.thread_id);
          yield* importer.ensureTranscript(id);
          const source = yield* projections.getThreadProjection(id);
          assert.equal(source.runs.length, 0);
          assert.equal(source.checkpoints.length, 0);
          const legacyDiff = yield* reader.get({ threadId: id, section: "diffs" });
          assert.equal(legacyDiff.restoreAllowed, false);
          assert.equal(legacyDiff.readOnly, true);
          assert.equal(
            legacyDiff.records[0]?.diff,
            "diff --git a/evidence b/evidence\n+legacy proof\n",
          );
          const provenance = yield* reader.get({ threadId: id, section: "provenance" });
          assert.isTrue(provenance.records.some((row) => row.kind === "thread.forked"));
          const forkId = ThreadId.make(`legacy-fork-${name}`);
          const input = {
            commandId: CommandId.make(`legacy-fork-${name}`),
            thread: {
              ...source.thread,
              id: forkId,
              forkedFrom: null,
              lineage: {
                parentThreadId: id,
                rootThreadId: id,
                relationshipToParent: "fork" as const,
              },
            },
            messages: source.messages,
          };
          yield* history.import(input);
          yield* history.import(input);
          const fork = yield* projections.getThreadProjection(forkId);
          assert.equal(fork.runs.length, 0);
          assert.equal(fork.checkpoints.length, 0);
          assert.equal(fork.thread.forkedFrom, null);
          assert.equal(fork.messages.length, source.messages.length);
          const inherited = yield* reader.get({ threadId: forkId, section: "diffs" });
          assert.equal(inherited.sourceThreadId, id);
          assert.deepStrictEqual(inherited.records, legacyDiff.records);
          yield* importer.reconcileShells;
          yield* importer.ensureTranscript(id);
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
            main,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
            forkLedger,
          );
          assert.deepStrictEqual(yield* runMigrations(), []);
          assert.deepStrictEqual(yield* runForkMigrations(), []);
        }).pipe(Effect.provide(servicesFor(db)));
        assert.deepStrictEqual(snapshotLegacy(file), before);
      }),
  );
});

it.effect(
  "reads historical goals/tools/checkpoints without enabling automation, and pages evidence",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* Projections.ProjectionStoreV2;
      const reader = yield* History.HistoryReader;
      const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");
      const id = ThreadId.make("history-test");
      yield* projections.apply({
        id: EventId.make("history-created"),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: { ...v2Projection.thread, id },
      });
      // The fixture-independent proof uses a fork-owned transferred evidence row.
      yield* sql`CREATE TABLE IF NOT EXISTS fork_transferred_history (thread_id TEXT PRIMARY KEY, payload TEXT NOT NULL)`;
      yield* sql`INSERT INTO fork_transferred_history VALUES (${id}, ${'{"previousTransfers":[{"nativeProjection":{"checkpoints":[{"id":"earlier-machine-checkpoint"}],"turnItems":[{"output":"earlier machine tool"}]},"sourceMetadata":{"scope":"earlier machine scope"}}],"legacyDiffs":[{"diff":"transferred V1 diff"}],"legacyBundle":{"version":2,"thread":{"id":"old","goal":{"objective":"old goal","status":"completed"},"checkpoints":[{"checkpointRef":"v1-ref"}],"activities":[{"id":"tool1","output":"one"},{"id":"tool2","output":"two"}]}}}'})`;
      assert.equal(
        (yield* reader.get({ threadId: id, section: "diffs" })).records[0]?.diff,
        "transferred V1 diff",
      );
      const first = yield* reader.get({ threadId: id, section: "tools", limit: 1 });
      assert.equal(first.records[0]?.output, "one");
      assert.equal(first.nextOffset, 1);
      const second = yield* reader.get({
        threadId: id,
        section: "tools",
        offset: first.nextOffset!,
        limit: 1,
      });
      assert.equal(second.records[0]?.output, "two");
      assert.equal(second.nextOffset, 2);
      const earlier = yield* reader.get({ threadId: id, section: "tools", offset: 2 });
      assert.equal(earlier.records[0]?.output, "earlier machine tool");
      assert.equal(earlier.nextOffset, null);
      const goals = yield* reader.get({ threadId: id, section: "goals" });
      assert.deepStrictEqual(goals.records[0]?.goal, {
        objective: "old goal",
        status: "completed",
      });
      const checkpoints = yield* reader.get({ threadId: id, section: "turns" });
      assert.equal(checkpoints.records[0]?.checkpointRef, "v1-ref");
      assert.equal(checkpoints.records[1]?.id, "earlier-machine-checkpoint");
      assert.equal(checkpoints.restoreAllowed, false);
      assert.equal((yield* projections.getThreadProjection(id)).checkpoints.length, 0);
    }).pipe(Effect.provide(servicesFor(SqlitePersistenceMemory))),
);
