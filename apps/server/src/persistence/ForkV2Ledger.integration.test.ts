// @effect-diagnostics nodeBuiltinImport:off
import * as FS from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationManifest, runMigrations } from "./Migrations.ts";
import { runForkMigrations } from "./ForkMigrations.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";

it("preserves ids through60 and creates V2 at61/62 exactly once", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 60 });
      yield* runForkMigrations();
      const before = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const forkBefore = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      expect(yield* runMigrations()).toEqual([
        [61, "OrchestrationV2"],
        [62, "RemoveRedundantProjectionIndexes"],
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
        Array.from({ length: 62 }, (_, i) => i + 1),
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })), Effect.scoped),
  );
});

const fixtures = process.env.T3CODE_FORK_FIXTURES;
describe.runIf(fixtures !== undefined)("published fork snapshots", () => {
  for (const name of ["dev-vm", "local-mbp"]) {
    it(`upgrades ${name} without changing historical rows or fork ledger`, async () => {
      const directory = await FS.mkdtemp(Path.join(OS.tmpdir(), "fork-v2-ledger-"));
      const destination = Path.join(directory, "statev2.sqlite");
      try {
        await FS.copyFile(Path.join(fixtures!, `${name}.small.sanitized.sqlite`), destination);
        const snapshot = () => {
          const database = new DatabaseSync(destination, { readOnly: true });
          try {
            return {
              main: database
                .prepare(
                  "SELECT * FROM effect_sql_migrations WHERE migration_id <=60 ORDER BY migration_id",
                )
                .all(),
              fork: database
                .prepare("SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id")
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
        for (let startup = 0; startup < 2; startup++) {
          await Effect.runPromise(
            Effect.gen(function* () {
              const sql = yield* SqlClient.SqlClient;
              expect(
                yield* sql`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >=61 ORDER BY migration_id`,
              ).toEqual([
                { migration_id: 61, name: "OrchestrationV2" },
                { migration_id: 62, name: "RemoveRedundantProjectionIndexes" },
              ]);
              expect(
                yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_effect_outbox'`,
              ).toHaveLength(1);
            }).pipe(
              Effect.provide(
                makeSqlitePersistenceLive(destination).pipe(Layer.provideMerge(NodeServices.layer)),
              ),
              Effect.scoped,
            ),
          );
          expect(snapshot()).toEqual(before);
        }
      } finally {
        await FS.rm(directory, { recursive: true, force: true });
      }
    });
  }
});
