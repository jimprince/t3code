import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { AutomationStore, layer as storeLayer } from "./AutomationStore.ts";

it.effect(
  "fresh databases seed eight editable scripts exactly once and retain deleted starters",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ids = yield* sql<{
        migration_id: number;
      }>`SELECT migration_id FROM effect_sql_fork_migrations WHERE migration_id IN (9,10,13,14,15) ORDER BY migration_id`;
      assert.deepEqual(
        ids.map((row) => row.migration_id),
        [9, 10, 13, 14, 15],
      );
      const store = yield* AutomationStore;
      const scripts = yield* store.listScripts(null);
      assert.equal(scripts.length, 8);
      yield* store.saveScript({
        ...scripts[0]!,
        prompt: "Edited prompt",
        updatedAt: "2026-10-06T00:00:00Z",
      });
      yield* store.deleteScript(scripts[1]!.id);
      assert.deepEqual(yield* runForkMigrations(), []);
      const after = yield* store.listScripts(null);
      assert.equal(after.length, 7);
      assert.equal(after.find((script) => script.id === scripts[0]!.id)?.prompt, "Edited prompt");
    }).pipe(Effect.provide(storeLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)))),
);

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
if (fixtures) {
  it.effect.each(["dev-vm", "local-mbp", "synthetic-edges"])(
    "preserves scripts, tombstones, run history, source baselines and ledgers from copied %s state",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({
          directory: process.env.T3_AUTOMATION_TEST_TMP,
          prefix: "automation-import-",
        });
        const copy = path.join(temporary, "state.sqlite");
        yield* fs.copyFile(path.join(fixtures, `${name}.small.sanitized.sqlite`), copy);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const snapshot = () =>
            Effect.all([
              sql`SELECT * FROM automation_scripts ORDER BY script_id`,
              sql`SELECT * FROM automations ORDER BY automation_id`,
              sql`SELECT * FROM automation_runs ORDER BY run_id`,
              sql`SELECT * FROM automation_source_state ORDER BY state_key`,
              sql`SELECT * FROM projection_projects ORDER BY project_id`,
              sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
            ]);
          const before = yield* snapshot();
          yield* runMigrations();
          assert.deepEqual(yield* runForkMigrations(), []);
          assert.deepEqual(yield* snapshot(), before);
          // SQLite, not an in-memory registry, enforces run deduplication after cutover.
          const indexes = yield* sql<{
            sql: string | null;
          }>`SELECT sql FROM sqlite_master WHERE type='table' AND name='automation_runs'`;
          assert.match(indexes[0]!.sql!, /UNIQUE\s*\(automation_id,\s*dedupe_key\)/i);
          assert.deepEqual(yield* runForkMigrations(), []);
          assert.deepEqual(yield* snapshot(), before);
          yield* sql`INSERT INTO automation_runs (run_id,automation_id,project_id,dedupe_key,status,run_json,created_at) VALUES ('cutover-probe-1','cutover-probe','probe','slot','completed','{}','2026-10-06T00:00:00Z')`;
          const duplicate = yield* Effect.exit(
            sql`INSERT INTO automation_runs (run_id,automation_id,project_id,dedupe_key,status,run_json,created_at) VALUES ('cutover-probe-2','cutover-probe','probe','slot','completed','{}','2026-10-06T00:00:00Z')`,
          );
          assert.equal(duplicate._tag, "Failure");
          const retained =
            yield* sql`SELECT run_id FROM automation_runs WHERE automation_id='cutover-probe'`;
          assert.equal(retained.length, 1);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: copy })));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
} else {
  it.effect.skip("copied-state fixtures require T3_LIFECYCLE_FIXTURES", () => Effect.void);
}
