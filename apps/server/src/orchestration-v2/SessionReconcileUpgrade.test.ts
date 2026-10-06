import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
for (const name of ["dev-vm.small.sanitized.sqlite", "local-mbp.small.sanitized.sqlite"]) {
  it.effect.skipIf(!fixtures)(
    `preserves both shipped ledgers on ${name} across repeated V2 startup`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({
          directory: process.env.T3_AUTOMATION_TEST_TMP,
          prefix: "m5-session-upgrade-",
        });
        const copy = path.join(directory, "state.sqlite");
        yield* fs.copyFile(path.join(fixtures!, name), copy);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const mainBefore =
            yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          const forkBefore =
            yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations ORDER BY migration_id`;
          assert.lengthOf(mainBefore, 60);
          assert.lengthOf(forkBefore, 15);
          assert.deepEqual(
            yield* runMigrations(),
            migrationManifest.filter(([id]) => id > 60),
          );
          const legacyThreads = yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`;
          assert.deepEqual(yield* runForkMigrations(), [[16, "ProjectionThreadsSubproject"]]);
          assert.deepEqual(
            yield* sql`SELECT * FROM projection_threads ORDER BY thread_id`,
            legacyThreads,
          );
          const mainAfter =
            yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
          assert.deepEqual(
            mainAfter.filter((row) => Number(row.migration_id) <= 60),
            mainBefore,
          );
          assert.deepEqual(
            yield* sql`SELECT migration_id, name FROM effect_sql_fork_migrations WHERE migration_id <= 15 ORDER BY migration_id`,
            forkBefore,
          );
          assert.deepEqual(yield* runMigrations(), []);
          assert.deepEqual(yield* runForkMigrations(), []);
          assert.deepEqual(
            yield* sql`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`,
            mainAfter,
          );
          assert.deepEqual(yield* sql`PRAGMA integrity_check`, [{ integrity_check: "ok" }]);
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: copy })));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
