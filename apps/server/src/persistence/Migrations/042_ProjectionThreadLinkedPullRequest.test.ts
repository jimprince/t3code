import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("042_ProjectionThreadLinkedPullRequest", (it) => {
  it.effect("adds the linked pull request column", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // The fork registers this upstream migration as id 47: ids 33-37 were
      // already applied on live fork databases before upstream published its
      // own 33-42, so upstream 33-42 run as 38-47 here (see Migrations.ts).
      yield* runMigrations({ toMigrationInclusive: 46 });
      yield* runMigrations({ toMigrationInclusive: 47 });

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "linked_pull_request_json"));
    }),
  );
});
