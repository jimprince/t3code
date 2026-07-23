import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  FORK_MIGRATIONS_TABLE,
  forkMigrationEntries,
  runForkMigrations,
} from "../ForkMigrations.ts";
import { migrationEntries, runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0001 from "./001_ProviderSessionRuntimeBootGeneration.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("001_ProviderSessionRuntimeBootGeneration", (it) => {
  it.effect(
    "adds the boot generation column idempotently while preserving legacy rows as null",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;

        yield* runMigrations();
        yield* sql`
          INSERT INTO provider_session_runtime (
            thread_id,
            provider_name,
            provider_instance_id,
            adapter_key,
            runtime_mode,
            status,
            last_seen_at,
            resume_cursor_json,
            runtime_payload_json
          ) VALUES (
            'thread-before-boot-generation',
            'codex',
            'codex',
            'codex',
            'full-access',
            'running',
            '2026-07-19T00:00:00.000Z',
            NULL,
            NULL
          )
        `;

        yield* Migration0001;
        yield* Migration0001;
        yield* runForkMigrations();

        const columns = yield* sql<{ readonly name: string }>`
          PRAGMA table_info(provider_session_runtime)
        `;
        assert.ok(columns.some((column) => column.name === "boot_generation_id"));

        const rows = yield* sql<{ readonly boot_generation_id: string | null }>`
          SELECT boot_generation_id
          FROM provider_session_runtime
          WHERE thread_id = 'thread-before-boot-generation'
        `;
        assert.deepStrictEqual(rows, [{ boot_generation_id: null }]);

        const forkMigrations = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`
          SELECT migration_id, name
          FROM effect_sql_fork_migrations
        `;
        assert.deepStrictEqual(forkMigrations, [
          { migration_id: 1, name: "ProviderSessionRuntimeBootGeneration" },
        ]);

        const upstreamCollision = yield* sql<{ readonly name: string }>`
          SELECT name FROM effect_sql_migrations
          WHERE name = 'ProviderSessionRuntimeBootGeneration'
        `;
        assert.deepStrictEqual(upstreamCollision, []);
      }),
  );

  it("keeps fork migration ids unique and outside the upstream tracking table", () => {
    const forkIds = forkMigrationEntries.map(([id]) => id);
    assert.equal(new Set(forkIds).size, forkIds.length);
    assert.notEqual(FORK_MIGRATIONS_TABLE, "effect_sql_migrations");
    assert.equal(
      migrationEntries.some(([, name]) => String(name) === "ProviderSessionRuntimeBootGeneration"),
      false,
    );
  });
});
