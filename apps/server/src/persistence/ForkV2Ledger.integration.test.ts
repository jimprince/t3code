import { assertFixtureMigration16 } from "./fixtureMigration16.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import { runForkMigrations } from "./ForkMigrations.ts";
import { layerFromPath as makeSqlitePersistenceLive } from "./Sqlite.ts";

it.effect("preserves ids through60 and appends migrations61–66 exactly once", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 60 });
    yield* runForkMigrations();
    const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    const forkBefore = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
    expect(yield* runMigrations()).toEqual([
      [61, "OrchestrationV2"],
      [62, "RemoveRedundantProjectionIndexes"],
      [63, "ScheduledTaskWebhooks"],
      [64, "WebhookRelayDeliveries"],
      [65, "McpAppModelContext"],
      [66, "ThreadSnapshotWindowIndexes"],
    ]);
    expect(
      yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 60 ORDER BY migration_id`,
    ).toEqual(before);
    expect(yield* runMigrations()).toEqual([]);
    expect(yield* runForkMigrations()).toEqual([]);
    expect(yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`).toEqual(
      forkBefore,
    );
    expect(
      yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_effect_outbox'`,
    ).toHaveLength(1);
    expect(migrationManifest.map(([id]) => id)).toEqual(
      Array.from({ length: 66 }, (_, i) => i + 1),
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
);

const fixtures = process.env.T3CODE_FORK_FIXTURES;
describe.runIf(fixtures !== undefined)("published fork snapshots", () => {
  it.effect.each(["dev-vm", "local-mbp"])(
    "upgrades %s without changing historical rows or historical fork ledger",
    (name) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-v2-ledger-")),
        );
        const destination = NodePath.join(directory, "statev2.sqlite");
        try {
          yield* Effect.promise(() =>
            NodeFSP.copyFile(
              NodePath.join(fixtures!, `${name}.small.sanitized.sqlite`),
              destination,
            ),
          );
          const snapshot = () => {
            const database = new NodeSqlite.DatabaseSync(destination, { readOnly: true });
            try {
              return {
                main: database
                  .prepare(
                    "SELECT * FROM effect_sql_migrations WHERE migration_id <=60 ORDER BY migration_id",
                  )
                  .all(),
                fork: database
                  .prepare(
                    "SELECT * FROM effect_sql_fork_migrations WHERE migration_id <=15 ORDER BY migration_id",
                  )
                  .all(),
                messages: database
                  .prepare("SELECT * FROM projection_thread_messages ORDER BY message_id")
                  .all(),
              };
            } finally {
              database.close();
            }
          };
          const before = snapshot();
          yield* assertFixtureMigration16.pipe(
            Effect.provide(NodeSqliteClient.layer({ filename: destination })),
          );
          for (let startup = 0; startup < 2; startup++) {
            yield* Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              expect(
                yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >=61 ORDER BY migration_id`,
              ).toEqual([
                { migration_id: 61, name: "OrchestrationV2" },
                { migration_id: 62, name: "RemoveRedundantProjectionIndexes" },
                { migration_id: 63, name: "ScheduledTaskWebhooks" },
                { migration_id: 64, name: "WebhookRelayDeliveries" },
                { migration_id: 65, name: "McpAppModelContext" },
                { migration_id: 66, name: "ThreadSnapshotWindowIndexes" },
              ]);
              expect(
                yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_effect_outbox'`,
              ).toHaveLength(1);
            }).pipe(
              Effect.provide(
                makeSqlitePersistenceLive(destination).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
              Effect.scoped,
            );
            expect(snapshot()).toEqual(before);
          }
        } finally {
          yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
        }
      }),
  );
});
