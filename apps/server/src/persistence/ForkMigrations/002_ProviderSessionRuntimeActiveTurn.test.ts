import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";
import Migration0001 from "./001_ProviderSessionRuntimeBootGeneration.ts";
import Migration0002 from "./002_ProviderSessionRuntimeActiveTurn.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("002_ProviderSessionRuntimeActiveTurn", (it) => {
  it.effect("adds and backfills the active turn column idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations();
      yield* Migration0001;
      yield* sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          boot_generation_id,
          adapter_key,
          runtime_mode,
          status,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        ) VALUES (
          'thread-before-active-turn',
          'codex',
          'codex',
          'boot-a',
          'codex',
          'full-access',
          'running',
          '2026-07-23T00:00:00.000Z',
          NULL,
          '{"activeTurnId":"turn-before-migration"}'
        )
      `;

      yield* Migration0002;
      yield* Migration0002;

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(provider_session_runtime)
      `;
      assert.ok(columns.some((column) => column.name === "active_turn_id"));

      const rows = yield* sql<{ readonly active_turn_id: string | null }>`
        SELECT active_turn_id
        FROM provider_session_runtime
        WHERE thread_id = 'thread-before-active-turn'
      `;
      assert.deepStrictEqual(rows, [{ active_turn_id: "turn-before-migration" }]);
    }),
  );
});
