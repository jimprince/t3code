// @effect-diagnostics nodeBuiltinImport:off -- Match the synchronous native executable resolver and recheck execution directory identity on ENOENT.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform, HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { recordProcessLaunch, processLaunchesLastMinute } from "../../processLaunchDiagnostics.ts";
import type { ProcessRunner, ProcessRunInput } from "../../processRunner.ts";
const encodeExecutableCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Background callers opt in; interactive operations and checkpoints keep their own deadlines. */
export const BackgroundProcessWork = Context.Reference<boolean>("t3/BackgroundProcessWork", {
  defaultValue: () => false,
});
export const ExecutableCacheGeneration = Context.Reference<string>("t3/ExecutableCacheGeneration", {
  defaultValue: () => "",
});
export const makeBudgetedRun = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  runCore: (
    spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
    resolved: ProcessRunInput,
    original: ProcessRunInput,
  ) => ReturnType<ProcessRunner["Service"]["run"]>,
  commandName: (command: string) => string,
  hasWindowsCommandNotFoundMessage: (output: string) => boolean,
) =>
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const hostEnvironment = yield* HostProcessEnvironment;
    const resolveExecutable = yield* SpawnExecutableResolution;
    const launchLock = yield* Semaphore.make(1);
    const backgroundLock = yield* Semaphore.make(1);
    const missing = new Map<string, { until: number; cause: PlatformError.PlatformError }>();
    const resolved = new Map<string, string>();
    let nextBackgroundLaunch = 0;
    let lastLog = 0;

    const run: ProcessRunner["Service"]["run"] = (input) =>
      Effect.gen(function* () {
        const env =
          input.env === undefined ? hostEnvironment : { ...hostEnvironment, ...input.env };
        const generation = yield* ExecutableCacheGeneration;
        const executionCwd = input.spawnCwd ?? input.cwd;
        const pathApi = platform === "win32" ? NodePath.win32 : NodePath.posix;
        const lookupCwd = executionCwd ?? process.cwd();
        const lookupEnv = { ...env };
        const pathKey = platform === "win32" && env.Path !== undefined ? "Path" : "PATH";
        if (lookupEnv[pathKey] !== undefined)
          lookupEnv[pathKey] = lookupEnv[pathKey]!.split(platform === "win32" ? ";" : ":")
            .map((entry) => pathApi.resolve(lookupCwd, entry))
            .join(platform === "win32" ? ";" : ":");
        const lookupCommand =
          input.command.includes("/") || input.command.includes("\\")
            ? pathApi.resolve(lookupCwd, input.command)
            : input.command;
        const directoryExists = () => {
          if (executionCwd === undefined) return true;
          try {
            return NodeFS.statSync(executionCwd).isDirectory();
          } catch {
            return false;
          }
        };
        const key = encodeExecutableCacheKey([
          input.command,
          env.PATH,
          env.Path,
          env.PATHEXT,
          generation,
          // Relative executable/PATH entries depend on the execution directory.
          input.command.includes("/") ||
          input.command.includes("\\") ||
          (env.PATH ?? "")
            .split(platform === "win32" ? ";" : ":")
            .some((entry) => !entry.startsWith("/"))
            ? (input.spawnCwd ?? input.cwd)
            : null,
        ]);
        const background = yield* BackgroundProcessWork;
        const invocationSpawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            const beforeBudget = missing.get(key);
            if (beforeBudget !== undefined && beforeBudget.until > (yield* Clock.currentTimeMillis))
              return yield* Effect.fail(beforeBudget.cause);
            const launch = launchLock.withPermits(1)(
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                const absent = missing.get(key);
                if (absent !== undefined && absent.until > now)
                  return yield* Effect.fail(absent.cause);
                missing.delete(key);
                for (const [cachedKey, value] of missing)
                  if (value.until <= now) missing.delete(cachedKey);
                while (missing.size >= 2048) missing.delete(missing.keys().next().value!);
                while (resolved.size > 2048) resolved.delete(resolved.keys().next().value!);
                const attemptedAt = yield* Clock.currentTimeMillis;
                if (background) nextBackgroundLaunch = attemptedAt + 200;
                const executable = commandName(input.command);
                recordProcessLaunch(attemptedAt, executable, "attempted");
                return yield* spawner.spawn(command).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => recordProcessLaunch(attemptedAt, executable, "spawned")),
                  ),
                  Effect.tapError((cause) =>
                    Effect.sync(() => {
                      recordProcessLaunch(attemptedAt, executable, "failed");
                      // A missing cwd can also produce ENOENT. Cache only when the executable is absent.
                      if (cause.reason._tag === "NotFound") {
                        resolved.delete(key);
                        if (
                          directoryExists() &&
                          resolveExecutable(lookupCommand, platform, lookupEnv) === undefined
                        ) {
                          missing.set(key, { until: attemptedAt + 10 * 60_000, cause });
                        }
                      }
                    }),
                  ),
                  Effect.ensuring(
                    Effect.gen(function* () {
                      if (attemptedAt - lastLog >= 60_000) {
                        lastLog = attemptedAt;
                        yield* Effect.logInfo("direct process launches in the last minute", {
                          executables: processLaunchesLastMinute(attemptedAt),
                        });
                      }
                    }),
                  ),
                );
              }),
            );
            return yield* background
              ? backgroundLock.withPermits(1)(
                  Effect.gen(function* () {
                    const now = yield* Clock.currentTimeMillis;
                    if (nextBackgroundLaunch > now)
                      yield* Effect.sleep(Duration.millis(nextBackgroundLaunch - now));
                    return yield* launch;
                  }),
                )
              : launch;
          }),
        );
        // Successful PATH resolution is reused for the lifetime of this runner/environment.
        const executable =
          resolved.get(key) ?? resolveExecutable(lookupCommand, platform, lookupEnv);
        if (executable !== undefined) {
          resolved.set(key, executable);
          missing.delete(key);
        }
        const result = yield* runCore(
          invocationSpawner,
          executable === undefined ? input : { ...input, command: executable },
          input,
        );
        if (
          platform === "win32" &&
          directoryExists() &&
          (result.code === 9009 || hasWindowsCommandNotFoundMessage(result.stderr))
        ) {
          missing.set(key, {
            until: (yield* Clock.currentTimeMillis) + 10 * 60_000,
            cause: PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcessSpawner",
              method: "spawn",
            }),
          });
        }
        return result;
      });

    return run;
  });
