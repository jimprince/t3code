import { assertFixtureMigration16 } from "../persistence/fixtureMigration16.testkit.ts";
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
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
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
import * as Settlement from "../orchestration-v2/ThreadSettlementService.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";
import * as Git from "../git/GitManager.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Terminals from "../terminal/Manager.ts";
import * as Maintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
const encodeHistoricalSettlement = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ threadId: Schema.String, settledAt: Schema.String })),
);
const decodeSettlementOrder = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ activeOrderKey: Schema.NullOr(Schema.String) })),
);
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
            : table === "effect_sql_fork_migrations"
              ? " WHERE migration_id <= 15"
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
  it.effect(
    "startup auto-settles an aged import while a recent manual order survives restart",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-10-06T12:00:00Z"));
        const temporary = yield* Effect.tryPromise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-startup-order-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
        );
        const file = NodePath.join(temporary, "statev2.sqlite");
        yield* Effect.tryPromise(() =>
          NodeFSP.copyFile(NodePath.join(fixtures!, "local-mbp.small.sanitized.sqlite"), file),
        );
        const aged = ThreadId.make("import-order-aged");
        const recent = ThreadId.make("import-order-recent");
        yield* Effect.tryPromise(async () => {
          const copy = new NodeSqlite.DatabaseSync(file);
          try {
            const thread = copy.prepare("SELECT * FROM projection_threads LIMIT 1").get()!;
            const message = copy
              .prepare("SELECT * FROM projection_thread_messages WHERE role = 'user' LIMIT 1")
              .get()!;
            for (const [id, at] of [
              [aged, "2026-10-02T12:00:00Z"],
              [recent, "2026-10-05T12:00:00Z"],
            ] as const) {
              const row = {
                ...thread,
                thread_id: id,
                created_at: at,
                updated_at: at,
                active_order_key: "xk",
                archived_at: null,
                deleted_at: null,
                settled_override: null,
                settled_at: null,
                parent_thread_id: null,
                pinned_at: null,
                auto_settle_disabled_at: null,
                snoozed_until: null,
                linked_pull_request_json: null,
                branch_pull_request_json: null,
              };
              copy
                .prepare(
                  `INSERT INTO projection_threads (${Object.keys(row).join(",")}) VALUES (${Object.keys(
                    row,
                  )
                    .map(() => "?")
                    .join(",")})`,
                )
                .run(...Object.values(row));
              const user = {
                ...message,
                message_id: `${id}:user`,
                thread_id: id,
                created_at: at,
                updated_at: at,
              };
              copy
                .prepare(
                  `INSERT INTO projection_thread_messages (${Object.keys(user).join(",")}) VALUES (${Object.keys(
                    user,
                  )
                    .map(() => "?")
                    .join(",")})`,
                )
                .run(...Object.values(user));
              copy
                .prepare(
                  "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json) VALUES (?, 'thread', ?, 1, 'thread.settled', '2026-01-01T00:00:00Z', 'user', ?, '{}')",
                )
                .run(
                  `${id}:historical-settle`,
                  id,
                  encodeHistoricalSettlement({ threadId: id, settledAt: "2026-01-01T00:00:00Z" }),
                );
            }
          } finally {
            copy.close();
          }
        });
        const before = snapshotLegacy(file);
        yield* assertFixtureMigration16.pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: file })),
        );
        for (const restart of [false, true]) {
          const db = makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
          const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "startup-import-order" },
            Registry.makeLayer([]),
            { databaseLayer: db, runEffectWorker: false },
          );
          yield* Effect.gen(function* () {
            const importer = yield* Legacy.LegacyV1ThreadImporter;
            const projections = yield* Projections.ProjectionStoreV2;
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const sql = yield* SqlClient.SqlClient;
            yield* importer.reconcileShells;
            yield* importer.ensureTranscript(aged);
            yield* importer.ensureTranscript(recent);
            assert.equal(
              (yield* projections.getThreadProjection(aged)).thread.activeOrderKey,
              restart ? null : "xk",
            );
            assert.equal(
              (yield* projections.getThreadProjection(recent)).thread.activeOrderKey,
              "xk",
            );
            const scanned = yield* Deferred.make<void>();
            const dependencies = Layer.mergeAll(
              Layer.succeed(Orchestrator.OrchestratorV2, orchestrator),
              Layer.succeed(Projections.ProjectionStoreV2, {
                ...projections,
                getSettlementCandidates: (id) =>
                  projections.getSettlementCandidates(id).pipe(
                    Effect.map((rows) =>
                      rows.filter((row) => row.id === aged || row.id === recent),
                    ),
                    Effect.tap(() => Deferred.succeed(scanned, undefined)),
                  ),
              }),
              Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
              Settings.layerTest(),
              Layer.mock(Git.GitManager)({
                branchPullRequest: () => Effect.die("Unexpected repository lookup"),
              }),
              Layer.mock(PullRequests.PullRequestService)({
                subscribeMerges: Effect.succeed(Stream.empty),
              }),
              Layer.mock(Terminals.TerminalManager)({ closeIdle: () => Effect.void }),
              Layer.succeed(
                Crypto.Crypto,
                Crypto.make({
                  randomBytes: (size) => new Uint8Array(size).fill(1),
                  digest: (_algorithm, data) => Effect.succeed(data),
                }),
              ),
              FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
            );
            yield* Effect.gen(function* () {
              const settlement = yield* Settlement.ThreadSettlementServiceV2;
              yield* settlement.start();
              yield* Deferred.await(scanned);
              yield* settlement.drain;
            }).pipe(
              Effect.provide(Settlement.layer.pipe(Layer.provide(dependencies))),
              Effect.scoped,
            );
            assert.equal(
              (yield* projections.getThreadProjection(aged)).thread.settledOverride,
              "settled",
            );
            assert.equal(
              (yield* projections.getThreadProjection(aged)).thread.activeOrderKey,
              null,
            );
            assert.equal(
              (yield* projections.getThreadProjection(recent)).thread.settledOverride,
              null,
            );
            assert.equal(
              (yield* projections.getThreadProjection(recent)).thread.activeOrderKey,
              "xk",
            );
            const events = yield* sql<{
              command_id: string;
              payload_json: string;
            }>`SELECT command_id, payload_json FROM orchestration_events WHERE application_event_version = 2 AND stream_id = ${aged} AND event_type = 'thread.settled'`;
            assert.equal(events.length, 1);
            assert.isTrue(events[0]!.command_id.startsWith(`server:auto-settle:${aged}:`));
            assert.equal(decodeSettlementOrder(events[0]!.payload_json).activeOrderKey, null);
          }).pipe(Effect.provide(Layer.merge(servicesFor(db), runtime)), Effect.scoped);
        }
        assert.deepStrictEqual(snapshotLegacy(file), before);
      }),
  );

  it.effect("keeps V1 manual order despite historical settlement on import and restart", () =>
    Effect.gen(function* () {
      const temporary = yield* Effect.tryPromise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-settled-order-")),
      );
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => NodeFSP.rm(temporary, { recursive: true, force: true })),
      );
      const file = NodePath.join(temporary, "statev2.sqlite");
      yield* Effect.tryPromise(() =>
        NodeFSP.copyFile(NodePath.join(fixtures!, "local-mbp.small.sanitized.sqlite"), file),
      );
      const id = yield* Effect.tryPromise(async () => {
        const copy = new NodeSqlite.DatabaseSync(file);
        try {
          const row = copy
            .prepare(
              "SELECT thread_id FROM projection_threads WHERE deleted_at IS NULL ORDER BY thread_id LIMIT 1",
            )
            .get()!;
          const id = String(row.thread_id);
          copy
            .prepare(
              "UPDATE projection_threads SET archived_at = NULL, pinned_at = NULL, active_order_key = 'xk', settled_override = 'settled', settled_at = '2026-01-01T00:00:00Z' WHERE thread_id = ?",
            )
            .run(id);
          copy
            .prepare(
              "INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json) VALUES (?, 'thread', ?, 999999, 'thread.settled', '2026-01-01T00:00:00Z', NULL, NULL, NULL, 'user', ?, '{}')",
            )
            .run(
              "historical-settle-order",
              id,
              encodeHistoricalSettlement({ threadId: id, settledAt: "2026-01-01T00:00:00Z" }),
            );
          return ThreadId.make(id);
        } finally {
          copy.close();
        }
      });
      const before = snapshotLegacy(file);
      yield* assertFixtureMigration16.pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: file })),
      );
      for (const restart of [false, true]) {
        const db = makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
        const runtime = makeOrchestratorV2ReplayLayerWithRegistry(
          { name: "import-settled-order" },
          Registry.makeLayer([]),
          { databaseLayer: db, runEffectWorker: false },
        );
        const services = Layer.mergeAll(
          servicesFor(db),
          runtime,
          Maintenance.layer.pipe(Layer.provide(storesFor(db))),
        );
        yield* Effect.gen(function* () {
          const importer = yield* Legacy.LegacyV1ThreadImporter;
          const projections = yield* Projections.ProjectionStoreV2;
          const maintenance = yield* Maintenance.ProjectionMaintenanceV2;
          const result = yield* importer.reconcileShells;
          if (restart) assert.equal(result.importedThreadCount, 0);
          yield* importer.ensureTranscript(id);
          const thread = (yield* projections.getThreadProjection(id)).thread;
          assert.equal(thread.activeOrderKey, "xk");
          assert.equal(thread.settledOverride, "settled");
          yield* maintenance.rebuild;
          assert.equal((yield* projections.getThreadProjection(id)).thread.activeOrderKey, "xk");
          if (restart) {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            yield* orchestrator.dispatch({
              type: "thread.settle",
              threadId: id,
              commandId: CommandId.make("live-settle-imported-order"),
            });
            assert.equal((yield* projections.getThreadProjection(id)).thread.activeOrderKey, null);
            yield* importer.reconcileShells;
            yield* maintenance.rebuild;
            assert.equal((yield* projections.getThreadProjection(id)).thread.activeOrderKey, null);
          }
        }).pipe(Effect.provide(services), Effect.scoped);
      }
      assert.deepStrictEqual(snapshotLegacy(file), before);
    }),
  );

  it.effect.each(["null", "absent", "modern"])(
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
            if (newerKey === "null")
              copy.exec("DELETE FROM effect_sql_fork_migrations WHERE migration_id = 5");
            return ids.map((id) => ThreadId.make(id));
          } finally {
            copy.close();
          }
        });
        const before = snapshotLegacy(file);
        yield* assertFixtureMigration16.pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: file })),
        );
        const db = makeSqlitePersistenceLive(file).pipe(Layer.provide(NodeServices.layer));
        yield* Effect.gen(function* () {
          const importer = yield* Legacy.LegacyV1ThreadImporter;
          const projections = yield* Projections.ProjectionStoreV2;
          const sink = yield* Sink.EventSinkV2;
          const sql = yield* SqlClient.SqlClient;
          yield* importer.reconcileShells;
          assert.equal(
            (yield* projections.getThreadProjection(ids[0]!)).thread.activeOrderKey,
            newerKey === "modern" ? null : "a0",
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
        yield* assertFixtureMigration16.pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: file })),
        );
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
          assert.equal(forkLedger.at(-1)?.migration_id, 16);
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
