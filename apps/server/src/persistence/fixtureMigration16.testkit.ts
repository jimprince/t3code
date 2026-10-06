import { assert } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import { runForkMigrations } from "./ForkMigrations.ts";

/** Upgrade a disposable shipped fixture while proving historical ledger preservation. */
export const assertFixtureMigration16 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const mainBefore =
    yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 62 ORDER BY migration_id`;
  const forkBefore = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
  assert.equal(forkBefore.at(-1)?.migration_id, 15);
  yield* runMigrations();
  assert.deepEqual(yield* runForkMigrations(), [[16, "ProjectionThreadsSubproject"]]);
  const mainAfter = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
  const forkAfter = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
  assert.deepEqual(mainAfter.slice(0, mainBefore.length), mainBefore);
  assert.equal(mainAfter.at(-1)?.migration_id, 62);
  assert.deepEqual(forkAfter.slice(0, forkBefore.length), forkBefore);
  assert.deepEqual(
    forkAfter.slice(forkBefore.length).map(({ migration_id, name }) => ({ migration_id, name })),
    [{ migration_id: 16, name: "ProjectionThreadsSubproject" }],
  );
  assert.deepEqual(yield* runMigrations(), []);
  assert.deepEqual(yield* runForkMigrations(), []);
  assert.deepEqual(
    yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
    mainAfter,
  );
  assert.deepEqual(
    yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
    forkAfter,
  );
});
