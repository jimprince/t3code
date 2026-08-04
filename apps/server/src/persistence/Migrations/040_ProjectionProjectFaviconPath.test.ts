import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("040_ProjectionProjectFaviconPath", (it) => {
  it.effect("adds the nullable favicon path to project projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The fork registers this upstream migration as id 45: ids 33-37 were
      // already applied on live fork databases before upstream published its
      // own 33-40, so upstream 33-40 run as 38-45 here (see Migrations.ts).
      yield* runMigrations({ toMigrationInclusive: 44 });
      yield* runMigrations({ toMigrationInclusive: 45 });

      const columns = yield* sql<{ readonly name: string; readonly notnull: number }>`
        PRAGMA table_info(projection_projects)
      `;
      const faviconPath = columns.find((column) => column.name === "favicon_path");

      assert.equal(faviconPath?.name, "favicon_path");
      assert.equal(faviconPath?.notnull, 0);
    }),
  );
});
