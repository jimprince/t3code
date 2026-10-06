/** Fork-owned migrations, tracked separately from upstream's migration sequence. */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";

import Migration0001 from "./ForkMigrations/001_ProviderSessionRuntimeBootGeneration.ts";
import Migration0002 from "./ForkMigrations/002_ProviderSessionRuntimeActiveTurn.ts";
import Migration0003 from "./ForkMigrations/003_ProjectionThreadMessageFileAttachments.ts";
import Migration0005 from "./ForkMigrations/005_MigrateSidebarOrderEvents.ts";
import Migration0006 from "./ForkMigrations/006_ProjectionThreadsParentThread.ts";
import Migration0007 from "./ForkMigrations/007_ThreadBackgroundWork.ts";

import Migration0008 from "./ForkMigrations/008_ProjectionThreadsSettleOnComplete.ts";
import Migration0009 from "./ForkMigrations/009_ProjectionProjectsPermanentAgent.ts";

import Migration0010 from "./ForkMigrations/010_ProjectionProjectAutomations.ts";
import Migration0011 from "./ForkMigrations/011_ProjectionThreadsScope.ts";

import Migration0012 from "./ForkMigrations/012_ProjectionThreadsRemoteParent.ts";
import Migration0013 from "./ForkMigrations/013_Automations.ts";
import Migration0014 from "./ForkMigrations/014_AutomationStarterScripts.ts";
import Migration0015 from "./ForkMigrations/015_AutomationSourceState.ts";
import Migration0016 from "./ForkMigrations/016_ProjectionThreadsSubproject.ts";

export const FORK_MIGRATIONS_TABLE = "effect_sql_fork_migrations";

export const forkMigrationEntries = [
  [1, "ProviderSessionRuntimeBootGeneration", Migration0001],
  [2, "ProviderSessionRuntimeActiveTurn", Migration0002],
  [3, "ProjectionThreadMessageFileAttachments", Migration0003],
  // ID 4 was published as ProjectionThreadsSidebarOrderKey; do not reuse it.
  [5, "MigrateSidebarOrderEvents", Migration0005],
  [6, "ProjectionThreadsParentThread", Migration0006],
  [7, "ThreadBackgroundWork", Migration0007],
  [8, "ProjectionThreadsSettleOnComplete", Migration0008],
  [9, "ProjectionProjectsPermanentAgent", Migration0009],
  [10, "ProjectionProjectAutomations", Migration0010],
  [11, "ProjectionThreadsScope", Migration0011],
  [12, "ProjectionThreadsRemoteParent", Migration0012],
  [13, "Automations", Migration0013],
  [14, "AutomationStarterScripts", Migration0014],
  [15, "AutomationSourceState", Migration0015],
  [16, "ProjectionThreadsSubproject", Migration0016],
] as const;

const makeForkMigrationLoader = (throughId?: number) =>
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
