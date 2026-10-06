import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import { parseDashboardFile, type DashboardFile } from "./projectDashboard.logic.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** One writer for the settings file across every connection in this process. */
const fileLock = Semaphore.makeUnsafe(1);

/**
 * Per-project dashboard settings (widget order, tracker repository) in one small
 * server-side file, `<stateDir>/project-dashboards.json`. Read on demand, so every
 * connection and the request ledger see the same values without a cache.
 */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const filePath = path.join(serverConfig.stateDir, "project-dashboards.json");

  const read = fileSystem.readFileString(filePath).pipe(
    Effect.map((contents): DashboardFile => parseDashboardFile(contents)),
    Effect.orElseSucceed(() => parseDashboardFile(null)),
  );

  const modify = (change: (file: DashboardFile) => DashboardFile) =>
    fileLock.withPermit(
      Effect.gen(function* () {
        const next = change(yield* read);
        yield* writeFileStringAtomically({ filePath, contents: `${encodeJson(next)}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        return next;
      }),
    );

  return { read, modify };
});

export type ProjectDashboardStore = Effect.Success<typeof make>;
