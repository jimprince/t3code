import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import Migration0011 from "./011_ProjectionThreadsScope.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("011_ProjectionThreadsScope", (it) => {
  it.effect("adds nullable scope idempotently without changing existing threads", () =>
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
        VALUES ('legacy-thread', 'Legacy thread')
      `;

      yield* Migration0011;
      yield* Migration0011;

      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.ok(columns.some((column) => column.name === "scope"));
      const rows = yield* sql<{
        readonly thread_id: string;
        readonly title: string;
        readonly scope: string | null;
      }>`SELECT thread_id, title, scope FROM projection_threads`;
      assert.deepStrictEqual(rows, [
        { thread_id: "legacy-thread", title: "Legacy thread", scope: null },
      ]);
    }),
  );
});
