import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ForkRemoteParent } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata, listMetadata, writeMetadata } from "./MetadataStore.ts";

// The spool supplies a copied fixture; never open the source fixtures for writes.
const fixtures = process.env.T3_NESTING_TEST_FIXTURE?.split(";") ?? [undefined];
for (const fixture of fixtures)
  (fixture ? it.effect : it.effect.skip)(
    `shipped parents, scope, remote IDs, order keys and migration ledgers survive import twice (${fixture?.split("/").at(-1) ?? "no fixture"})`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const rows = yield* sql<{
          thread_id: string;
          parent_thread_id: string | null;
          scope: string | null;
          remote_parent_json: string | null;
          pin_order_key: string | null;
          active_order_key: string | null;
        }>`SELECT thread_id, parent_thread_id, scope, remote_parent_json, pin_order_key, active_order_key FROM projection_threads ORDER BY thread_id`;
        const ledger = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const forkLedger =
          yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
        yield* initializeMetadata(sql);
        const imported = yield* listMetadata(sql);
        assert.equal(imported.length, rows.length);
        for (const row of rows) {
          const metadata = imported.find((m) => m.threadId === row.thread_id)!;
          assert.equal(metadata.parentThreadId, row.parent_thread_id);
          assert.equal(metadata.scope, row.scope);
          if (row.remote_parent_json)
            assert.deepStrictEqual(
              metadata.remoteParent,
              yield* Schema.decodeEffect(Schema.fromJsonString(ForkRemoteParent))(
                row.remote_parent_json,
              ),
            );
        }
        const child = imported.find((row) => row.parentThreadId !== null)!;
        assert.isDefined(child);
        yield* writeMetadata(sql, { ...child, parentThreadId: null, scope: "V2 edit" });
        yield* initializeMetadata(sql);
        const after = (yield* listMetadata(sql)).find((row) => row.threadId === child.threadId)!;
        assert.equal(after.parentThreadId, null);
        assert.equal(after.scope, "V2 edit");
        assert.deepStrictEqual(
          yield* sql`SELECT thread_id, parent_thread_id, scope, remote_parent_json, pin_order_key, active_order_key FROM projection_threads ORDER BY thread_id`,
          rows,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          ledger,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
          forkLedger,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: fixture ?? ":memory:" }))),
  );
