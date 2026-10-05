/** Shipped fork ids are immutable, including the historical V1-only schema. */
import * as SqlClient from "effect/sql/SqlClient";
import * as Effect from "effect/Effect";
import Goals from "./Migrations/033_ProjectionThreadGoals.ts";
import Scopes from "./Migrations/034_RepairAuthAuthorizationScopes.ts";
import Proof from "./Migrations/035_RepairAuthPairingProofKeyThumbprint.ts";
import Kind from "./Migrations/036_ProjectionProjectsKind.ts";
import Unique from "./Migrations/037_UniqueProjectCreation.ts";
import Issues from "./Migrations/055_ProjectionThreadIssues.ts";

export const forkV2MigrationEntries = <E, R>(
  upstream: ReadonlyArray<readonly [number, string, Effect.Effect<void, E, R>]>,
) => [
  ...upstream.filter(([id]) => id <= 32),
  [33, "ProjectionThreadGoals", Goals] as const,
  [34, "RepairAuthAuthorizationScopes", Scopes] as const,
  [35, "RepairAuthPairingProofKeyThumbprint", Proof] as const,
  [36, "ProjectionProjectsKind", Kind] as const,
  [37, "UniqueProjectCreation", Unique] as const,
  ...upstream
    .filter(([id]) => id >= 33 && id <= 54)
    .map(([id, name, migration]) => [id + 5, name, migration] as const),
  [60, "ProjectionThreadIssues", Issues] as const,
  ...upstream
    .filter(([id]) => id >= 55)
    .map(
      ([id, name, migration]) =>
        [id + 6, name, id === 55 ? migrateV2(migration) : migration] as const,
    ),
];

/** V2 writes a separate project baseline into the shared event log. */
function migrateV2<E, R>(migration: Effect.Effect<void, E, R>) {
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP INDEX IF EXISTS idx_orch_events_unique_project_creation`;
    yield* migration;
    yield* sql`CREATE UNIQUE INDEX idx_orch_events_unique_project_creation
    ON orchestration_events(stream_id, application_event_version)
    WHERE aggregate_kind = 'project' AND event_type = 'project.created'`;
  });
}
