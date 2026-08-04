import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_ProjectionThreadTitleRegeneration", (it) => {
  it.effect("adds pending title regeneration columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The fork registers this upstream migration as id 40: ids 33-37 were
      // already applied on live fork databases before upstream published its
      // own 33-35, so upstream 33-35 run as 38-40 here (see Migrations.ts).
      yield* runMigrations({ toMigrationInclusive: 39 });
      yield* runMigrations({ toMigrationInclusive: 40 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      const names = new Set(columns.map((column) => column.name));
      assert.ok(names.has("title_regeneration_request_id"));
      assert.ok(names.has("title_regeneration_started_at"));
    }),
  );
});
