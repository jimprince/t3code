import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

// Published upstream previews used 53/54 for V2. Only those named ledger
// entries qualify: a normal fork V1 database at 60 must still execute V2 at 61.
export const reconcileV2PreviewMigration = <E, R>(
  entries: ReadonlyArray<readonly [number, string, Effect.Effect<void, E, R>]>,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables =
          yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
        if (tables.length === 0) return [];
        const history = yield* sql<{
          readonly migration_id: number;
          readonly name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id`;
        const legacy = history.find(
          (row) =>
            row.name === "OrchestrationV2" && (row.migration_id === 53 || row.migration_id === 54),
        );
        if (!legacy) return [];
        const upstreamNames = new Map(
          entries
            .filter(([id]) => id <= 32 || (id >= 38 && id <= 57))
            .map(([id, name]) => [id <= 32 ? id : id - 5, name]),
        );
        const prefix = history.filter((row) => row.migration_id <= 52);
        const valid =
          prefix.length === 52 &&
          (legacy.migration_id === 53 ||
            history.some(
              (row) => row.migration_id === 53 && row.name === "PullRequestFilesViewed",
            )) &&
          prefix.every((row) => upstreamNames.get(row.migration_id) === row.name) &&
          history
            .filter((row) => row.migration_id >= 53)
            .every(
              (row) =>
                row === legacy ||
                (legacy.migration_id === 54 &&
                  ((row.migration_id === 53 && row.name === "PullRequestFilesViewed") ||
                    (row.migration_id === 55 && row.name === "RemoveRedundantProjectionIndexes"))),
            );
        if (!valid)
          return yield* new Migrator.MigrationError({
            kind: "BadState",
            message: "Cannot upgrade V2 preview with unexpected migration history.",
          });
        // Move the already-applied V2 and optional cleanup before remapping the
        // upstream prefix; descending updates avoid colliding with occupied ids.
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 62 WHERE migration_id = 55 AND name = 'RemoveRedundantProjectionIndexes'`;
        yield* sql`UPDATE effect_sql_migrations SET migration_id = 61 WHERE migration_id = ${legacy.migration_id} AND name = 'OrchestrationV2'`;
        if (legacy.migration_id === 54)
          yield* sql`UPDATE effect_sql_migrations SET migration_id = 58 WHERE migration_id = 53 AND name = 'PullRequestFilesViewed'`;
        for (const row of [...prefix].reverse()) {
          if (row.migration_id >= 33)
            yield* sql`UPDATE effect_sql_migrations SET migration_id = ${row.migration_id + 5} WHERE migration_id = ${row.migration_id}`;
        }
        const executed: Array<readonly [number, string]> = [];
        for (const [id, name, migration] of entries) {
          if (!((id >= 33 && id <= 37) || (id >= 58 && id <= 60))) continue;
          if (id === 58 && legacy.migration_id === 54) continue;
          if (id === 37) {
            // V2 already wrote a second project baseline into the shared event log.
            yield* sql`DROP INDEX IF EXISTS idx_orch_events_unique_project_creation`;
            yield* sql`CREATE UNIQUE INDEX idx_orch_events_unique_project_creation ON orchestration_events(stream_id, application_event_version) WHERE aggregate_kind = 'project' AND event_type = 'project.created'`;
          } else
            yield* migration.pipe(
              Effect.mapError(
                (cause) =>
                  new Migrator.MigrationError({
                    kind: "Failed",
                    message: `Preview upgrade ${id}_${name} failed`,
                    cause,
                  }),
              ),
            );
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
          executed.push([id, name]);
        }
        return executed;
      }),
    );
  });
