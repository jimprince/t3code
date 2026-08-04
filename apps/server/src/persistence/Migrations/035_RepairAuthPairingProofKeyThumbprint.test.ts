import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("035_RepairAuthPairingProofKeyThumbprint", (it) => {
  it.effect("repairs installs where migration 32 was consumed by ProjectionThreadGoals", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Reproduce the fork ledger collision: 31 ran as AuthAuthorizationScopes
      // schema (scoped tables, no proof key column), then ids 32-34 were
      // burned by the old fork numbering, so 032_AuthPairingProofKeyThumbprint
      // never executed.
      yield* runMigrations({ toMigrationInclusive: 31 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES
          (32, 'ProjectionThreadGoals', '2026-06-04 01:34:59'),
          (33, 'RepairAuthAuthorizationScopes', '2026-06-04 02:30:17'),
          (34, 'RepairAuthAuthorizationScopes', '2026-06-07 03:32:06')
      `;

      const beforeColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.isFalse(
        beforeColumns.some((column) => column.name === "proof_key_thumbprint"),
        "REGRESSION SETUP: collision state must be missing proof_key_thumbprint",
      );

      yield* runMigrations({});

      const afterColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.isTrue(
        afterColumns.some((column) => column.name === "proof_key_thumbprint"),
        "REGRESSION: repair must add proof_key_thumbprint so pairing creation works",
      );

      yield* sql`
        INSERT INTO auth_pairing_links (
          id,
          credential,
          method,
          scopes,
          subject,
          created_at,
          expires_at,
          proof_key_thumbprint
        )
        VALUES (
          'link-repaired',
          'bootstrap-repaired',
          'desktop-bootstrap',
          '["orchestration:read"]',
          'desktop',
          '2026-06-10T00:00:00.000Z',
          '2026-06-10T01:00:00.000Z',
          'thumbprint-1'
        )
      `;
      const rows = yield* sql<{ readonly proofKeyThumbprint: string | null }>`
        SELECT proof_key_thumbprint AS "proofKeyThumbprint"
        FROM auth_pairing_links
        WHERE id = 'link-repaired'
      `;
      assert.strictEqual(rows[0]?.proofKeyThumbprint, "thumbprint-1");
    }),
  );

  it.effect("is a no-op on installs where migration 32 already ran", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({});

      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(auth_pairing_links)
      `;
      assert.strictEqual(
        columns.filter((column) => column.name === "proof_key_thumbprint").length,
        1,
        "proof_key_thumbprint must exist exactly once after a clean run",
      );
    }),
  );
});
