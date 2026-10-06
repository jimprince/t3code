import { assertFixtureMigration16 } from "../persistence/fixtureMigration16.testkit.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { NodeServices } from "@effect/platform-node";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";

// Each test copies the packaged source before any schema or metadata writes.
const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
for (const name of ["dev-vm", "local-mbp", "synthetic-edges"])
  (fixtures ? it.effect : it.effect.skip)(
    `shipped ledger and General Chat history survive sidecar import and restart (${name}; T3_LIFECYCLE_FIXTURES)`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-fixture-import-" });
        const copy = path.join(temporary, "state.sqlite");
        yield* fs.copyFile(path.join(fixtures!, `${name}.small.sanitized.sqlite`), copy);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          const forkLedger =
            yield* sql`SELECT * FROM effect_sql_fork_migrations WHERE migration_id <= 15 ORDER BY migration_id`;
          const projects = yield* sql<{
            project_id: string;
            kind: string;
          }>`SELECT project_id, kind FROM projection_projects ORDER BY project_id`;
          const threads =
            yield* sql`SELECT thread_id, project_id FROM projection_threads ORDER BY thread_id`;
          assert.isTrue(projects.some((project) => project.kind === "chat"));
          assert.isTrue(ledger.some((row) => row.name === "ProjectionProjectsKind"));
          assert.isTrue(ledger.some((row) => row.name === "UniqueProjectCreation"));
          // Shipped migrations are already recorded. Exercise the production ledger
          // runner instead of replaying old project-created events a second time.
          // The packaged sanitizer replaces provider instance IDs with UUIDs.
          // Normalize only this disposable copy, as the other project import test does.
          yield* sql`UPDATE projection_projects
            SET default_model_selection_json = json_set(default_model_selection_json, '$.instanceId', 'codex')
            WHERE default_model_selection_json IS NOT NULL`;
          yield* assertFixtureMigration16;
          const upgradedLedger =
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          assert.deepStrictEqual(upgradedLedger.slice(0, ledger.length), ledger);
          assert.equal(upgradedLedger.at(-1)?.migration_id, 62);
          assert.deepStrictEqual(yield* runMigrations(), []);
          const store = yield* ProjectStore.make;
          const shells = yield* store.listShells();
          for (const shell of shells) {
            assert.equal(
              shell.kind,
              projects.find((project) => project.project_id === shell.id)?.kind,
            );
          }
          assert.deepStrictEqual(yield* runForkMigrations(), []);
          const restarted = yield* ProjectStore.make;
          assert.deepStrictEqual(yield* restarted.listShells(), shells);
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
            upgradedLedger,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM effect_sql_fork_migrations WHERE migration_id <= 15 ORDER BY migration_id`,
            forkLedger,
          );
          assert.deepStrictEqual(
            yield* sql`SELECT thread_id, project_id FROM projection_threads ORDER BY thread_id`,
            threads,
          );
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: copy })));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
