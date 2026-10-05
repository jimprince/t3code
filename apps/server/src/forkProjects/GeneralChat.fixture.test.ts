import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import migration036 from "../persistence/Migrations/036_ProjectionProjectsKind.ts";
import migrationV2 from "../persistence/Migrations/055_OrchestrationV2.ts";
import migration037 from "../persistence/Migrations/037_UniqueProjectCreation.ts";

// Pass a disposable copy of an M0 fixture, never a live server database.
const fixture = process.env.T3_GENERAL_CHAT_TEST_FIXTURE;
(fixture ? it.effect : it.effect.skip)(
  "copied shipped ledger and General Chat history survive sidecar import and restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const forkLedger = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
      const projects = yield* sql<{
        project_id: string;
        kind: string;
      }>`SELECT project_id, kind FROM projection_projects ORDER BY project_id`;
      const threads =
        yield* sql`SELECT thread_id, project_id FROM projection_threads ORDER BY thread_id`;
      assert.isTrue(projects.some((project) => project.kind === "chat"));
      assert.isTrue(ledger.some((row) => row.name === "ProjectionProjectsKind"));
      assert.isTrue(ledger.some((row) => row.name === "UniqueProjectCreation"));
      yield* migration036;
      yield* migration037;
      yield* sql.withTransaction(migrationV2);
      const store = yield* ProjectStore.make;
      const shells = yield* store.listShells();
      for (const shell of shells) {
        assert.equal(shell.kind, projects.find((project) => project.project_id === shell.id)?.kind);
      }
      const restarted = yield* ProjectStore.make;
      assert.deepStrictEqual(yield* restarted.listShells(), shells);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        ledger,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
        forkLedger,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT thread_id, project_id FROM projection_threads ORDER BY thread_id`,
        threads,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: fixture ?? ":memory:" }))),
);
