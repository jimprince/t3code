import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0012 from "./012_ProjectionThreadsRemoteParent.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("012_ProjectionThreadsRemoteParent", (it) => {
  it.effect("adds nullable remote parentage idempotently without changing existing flat rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (thread_id, title)
        VALUES ('legacy-flat-thread', 'Legacy flat thread')
      `;

      yield* Migration0012;
      yield* Migration0012;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(columns.some((column) => column.name === "remote_parent_json"));
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly title: string;
        readonly remote_parent_json: string | null;
      }>`
        SELECT thread_id, title, remote_parent_json
        FROM projection_threads
      `;
      assert.deepStrictEqual(rows, [
        {
          thread_id: "legacy-flat-thread",
          title: "Legacy flat thread",
          remote_parent_json: null,
        },
      ]);
    }),
  );
});
