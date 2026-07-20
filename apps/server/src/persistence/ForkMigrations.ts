/** Fork-owned migrations, tracked separately from upstream's migration sequence. */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./ForkMigrations/001_ProviderSessionRuntimeBootGeneration.ts";

export const FORK_MIGRATIONS_TABLE = "effect_sql_fork_migrations";

export const forkMigrationEntries = [
  [1, "ProviderSessionRuntimeBootGeneration", Migration0001],
] as const;

export const makeForkMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

export interface RunForkMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runForkMigrations = Effect.fn("runForkMigrations")(function* ({
  toMigrationInclusive,
}: RunForkMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeForkMigrationLoader(toMigrationInclusive),
    table: FORK_MIGRATIONS_TABLE,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Fork database schema is current")
    : Effect.log("Fork migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

export const ForkMigrationsLive = Layer.effectDiscard(runForkMigrations());
