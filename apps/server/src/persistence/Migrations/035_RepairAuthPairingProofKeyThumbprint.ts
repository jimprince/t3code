import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs fork installs where migration id 32 was consumed by the old
 * ProjectionThreadGoals migration before upstream AuthPairingProofKeyThumbprint
 * was rebased in at the same id, leaving auth_pairing_links without the
 * proof_key_thumbprint column and breaking pairing credential creation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const pairingLinkColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_pairing_links)
  `;
  if (!pairingLinkColumns.some((column) => column.name === "proof_key_thumbprint")) {
    yield* sql`
      ALTER TABLE auth_pairing_links
      ADD COLUMN proof_key_thumbprint TEXT
    `;
  }
});
