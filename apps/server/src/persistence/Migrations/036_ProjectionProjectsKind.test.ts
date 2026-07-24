import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("036_ProjectionProjectsKind", (it) => {
  it.effect("backfills historical projects as workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 35 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'historical-project', 'Historical Project', '/tmp/historical-project',
          NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;

      yield* runMigrations();
      const rows = yield* sql<{ readonly kind: string }>`
        SELECT kind FROM projection_projects WHERE project_id = 'historical-project'
      `;

      assert.deepStrictEqual(rows, [{ kind: "workspace" }]);
    }),
  );
});
