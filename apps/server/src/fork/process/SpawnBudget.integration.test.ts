import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as ProcessRunner from "../../processRunner.ts";
import { processLaunchesLastMinute } from "../../processLaunchDiagnostics.ts";

it.effect(
  "never caches a missing execution directory and counts only real subsequent attempts",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "spawn-budget-" });
      const cwd = `${root}/not-created`;
      let attempts = 0;
      const spawner = ChildProcessSpawner.make(() =>
        Effect.suspend(() => {
          attempts++;
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcessSpawner",
              method: "spawn",
            }),
          );
        }),
      );
      const runner = yield* ProcessRunner.make().pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
      const command = "t3-budget-missing-executable";
      const input = { command, cwd, args: [] };
      yield* runner.run(input).pipe(Effect.result);
      yield* fs.makeDirectory(cwd);
      yield* runner.run(input).pipe(Effect.result);
      yield* runner.run(input).pipe(Effect.result);
      expect(attempts).toBe(2);
      const rates = processLaunchesLastMinute(yield* Clock.currentTimeMillis)[command];
      expect(rates?.attempted).toBe(2);
      expect(rates?.failed).toBe(2);
      expect(rates?.spawned).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(NodeServices.layer),
      Effect.provideService(SpawnExecutableResolution, () => undefined),
    ),
);
