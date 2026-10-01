import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Semaphore from "effect/Semaphore";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { HostProcessPlatform, HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import { recordProcessLaunch, processLaunchesLastMinute } from "./processLaunchDiagnostics.ts";

const encodeExecutableCacheKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Background callers opt in; interactive operations and checkpoints keep their own deadlines. */
export const BackgroundProcessWork = Context.Reference<boolean>("t3/BackgroundProcessWork", {
  defaultValue: () => false,
});
export const ExecutableCacheGeneration = Context.Reference<string>("t3/ExecutableCacheGeneration", {
  defaultValue: () => "",
});
import {
  collectUint8StreamText,
  decodeUtf8,
  type CollectedUint8StreamText,
} from "./stream/collectUint8StreamText.ts";

export interface ProcessRunInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly timeout?: Duration.Input | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly stdin?: string | undefined;
  /** Receives every stdout chunk, including bytes beyond the buffered output limit. */
  readonly onStdoutChunk?: ((chunk: Uint8Array) => void) | undefined;
  readonly maxOutputBytes?: number | undefined;
  readonly outputMode?: "error" | "truncate" | undefined;
  readonly truncatedMarker?: string | undefined;
  /**
   * On timeout, return a synthetic timedOut result.
   * Partial stdout/stderr are not preserved.
   */
  readonly timeoutBehavior?: "error" | "timedOutResult" | undefined;
}

export interface ProcessRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: ChildProcessSpawner.ExitCode | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly stdoutInvalidUtf8: boolean;
  readonly stderrInvalidUtf8: boolean;
}

const ProcessInvocationFields = {
  command: Schema.String,
  argumentCount: Schema.Number,
  cwd: Schema.optional(Schema.String),
  spawnCwd: Schema.optional(Schema.String),
};

const formatProcessInvocation = (input: {
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
}): string => {
  const executionCwd = input.spawnCwd ?? input.cwd;
  return executionCwd === undefined
    ? `'${input.command}'`
    : `'${input.command}' in '${executionCwd}'`;
};

export class ProcessSpawnError extends Schema.TaggedError<ProcessSpawnError>()(
  "ProcessSpawnError",
  {
    ...ProcessInvocationFields,
    resolvedCommand: Schema.optional(Schema.String),
    resolvedArgumentCount: Schema.optional(Schema.Number),
    shell: Schema.optional(Schema.Boolean),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to spawn process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessStdinError extends Schema.TaggedError<ProcessStdinError>()(
  "ProcessStdinError",
  {
    ...ProcessInvocationFields,
    stdinBytes: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to write stdin for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessOutputLimitError extends Schema.TaggedError<ProcessOutputLimitError>()(
  "ProcessOutputLimitError",
  {
    ...ProcessInvocationFields,
    stream: Schema.Literals(["stdout", "stderr"]),
    maxBytes: Schema.Number,
    observedBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} ${this.stream} produced ${this.observedBytes} bytes, exceeding the ${this.maxBytes} byte limit`;
  }
}

export class ProcessReadError extends Schema.TaggedError<ProcessReadError>()("ProcessReadError", {
  ...ProcessInvocationFields,
  stream: Schema.Literals(["stdout", "stderr", "exitCode"]),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read ${this.stream} for process ${formatProcessInvocation(this)}`;
  }
}

export class ProcessTimeoutError extends Schema.TaggedError<ProcessTimeoutError>()(
  "ProcessTimeoutError",
  {
    ...ProcessInvocationFields,
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Process ${formatProcessInvocation(this)} timed out after ${this.timeoutMs}ms`;
  }
}

export const ProcessRunError = Schema.Union([
  ProcessSpawnError,
  ProcessStdinError,
  ProcessOutputLimitError,
  ProcessReadError,
  ProcessTimeoutError,
]);
export type ProcessRunError = typeof ProcessRunError.Type;

export class ProcessRunner extends Context.Service<
  ProcessRunner,
  {
    readonly run: (input: ProcessRunInput) => Effect.Effect<ProcessRunOutput, ProcessRunError>;
  }
>()("t3/processRunner") {}

const DEFAULT_TIMEOUT = "60 seconds";
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

const WINDOWS_COMMAND_NOT_FOUND_PATTERNS = [
  /is not recognized as an internal or external command/i,
  /n.o . reconhecido como um comando interno/i,
  /non . riconosciuto come comando interno o esterno/i,
  /n.est pas reconnu en tant que commande interne/i,
  /no se reconoce como un comando interno o externo/i,
  /wird nicht als interner oder externer befehl/i,
] as const;

function hasWindowsCommandNotFoundMessage(output: string): boolean {
  return WINDOWS_COMMAND_NOT_FOUND_PATTERNS.some((pattern) => pattern.test(output));
}

export const isWindowsCommandNotFound = Effect.fn("processRunner.isWindowsCommandNotFound")(
  function* (code: number | null, stderr: string) {
    const platform = yield* HostProcessPlatform;
    if (platform !== "win32") return false;
    if (code === 9009) return true;
    return hasWindowsCommandNotFoundMessage(stderr);
  },
);

// Untraced: no attributes, and its time is the runProcessCore span. Errors fail that span.
const collectText = Effect.fnUntraced(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly spawnCwd?: string | undefined;
  readonly streamName: "stdout" | "stderr";
  readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly maxOutputBytes: number;
  readonly outputMode: "error" | "truncate";
  readonly truncatedMarker: string;
}) {
  const stream = input.stream.pipe(
    Stream.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: input.streamName,
          cause,
        }),
    ),
  );

  if (input.outputMode === "truncate") {
    return yield* collectUint8StreamText({
      stream,
      maxBytes: input.maxOutputBytes,
      truncatedMarker: input.truncatedMarker,
    });
  }

  return yield* stream.pipe(
    Stream.runFoldEffect<
      {
        readonly chunks: Uint8Array<ArrayBufferLike>[];
        readonly bytes: number;
      },
      Uint8Array<ArrayBufferLike>,
      ProcessOutputLimitError | ProcessReadError,
      never
    >(
      () => ({ chunks: [], bytes: 0 }),
      (state, chunk) => {
        const remainingBytes = input.maxOutputBytes - state.bytes;
        if (chunk.byteLength > remainingBytes) {
          return Effect.fail(
            new ProcessOutputLimitError({
              command: input.command,
              argumentCount: input.args.length,
              cwd: input.cwd,
              spawnCwd: input.spawnCwd,
              stream: input.streamName,
              maxBytes: input.maxOutputBytes,
              observedBytes: state.bytes + chunk.byteLength,
            }),
          );
        }

        state.chunks.push(chunk);
        return Effect.succeed({
          chunks: state.chunks,
          bytes: state.bytes + chunk.byteLength,
        });
      },
    ),
    Effect.map((state): CollectedUint8StreamText => ({
      ...decodeUtf8(Buffer.concat(state.chunks, state.bytes)),
      bytes: state.bytes,
      truncated: false,
    })),
  );
});

function finalizeRunProcess<R>(
  effect: Effect.Effect<ProcessRunOutput, ProcessRunError, R | Scope.Scope>,
  input: ProcessRunInput,
): Effect.Effect<ProcessRunOutput, ProcessRunError, Exclude<R, Scope.Scope>> {
  const timeout = Duration.fromInputUnsafe(input.timeout ?? DEFAULT_TIMEOUT);
  const timeoutBehavior = input.timeoutBehavior ?? "error";

  return effect.pipe(
    Effect.scoped,
    Effect.timeoutOption(timeout),
    Effect.flatMap((result) => {
      if (Option.isSome(result)) {
        return Effect.succeed(result.value);
      }
      if (timeoutBehavior === "timedOutResult") {
        return Effect.succeed({
          stdout: "",
          stderr: "",
          code: null,
          timedOut: true,
          stdoutTruncated: false,
          stderrTruncated: false,
          stdoutInvalidUtf8: false,
          stderrInvalidUtf8: false,
        } satisfies ProcessRunOutput);
      }
      return Effect.fail(
        new ProcessTimeoutError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          timeoutMs: Duration.toMillis(timeout),
        }),
      );
    }),
  );
}

/** The executable name without its directory, recorded as `process.command` on process spans. */
export const commandName = (command: string) => command.replace(/^.*[\\/]/, "");

const runProcessCore = Effect.fn("processRunner.runProcessCore")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  input: ProcessRunInput,
): Effect.fn.Return<ProcessRunOutput, ProcessRunError, Scope.Scope> {
  yield* Effect.annotateCurrentSpan("process.command", commandName(input.command));
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const outputMode = input.outputMode ?? "error";
  const truncatedMarker = input.truncatedMarker ?? "";
  const extendEnv = input.env !== undefined;
  const spawnCommand = yield* resolveSpawnCommand(
    input.command,
    input.args,
    input.env === undefined ? {} : { env: input.env, extendEnv },
  );

  const child = yield* spawner
    .spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        ...((input.spawnCwd ?? input.cwd) ? { cwd: input.spawnCwd ?? input.cwd } : {}),
        ...(input.env !== undefined
          ? {
              env: input.env,
              extendEnv,
            }
          : {}),
        shell: spawnCommand.shell,
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProcessSpawnError({
            command: input.command,
            argumentCount: input.args.length,
            cwd: input.cwd,
            spawnCwd: input.spawnCwd,
            resolvedCommand: spawnCommand.command,
            resolvedArgumentCount: spawnCommand.args.length,
            shell: spawnCommand.shell,
            cause,
          }),
      ),
    );

  const stdin = input.stdin;
  const onStdoutChunk = input.onStdoutChunk;
  const writeStdin =
    stdin === undefined
      ? Effect.void
      : Stream.run(Stream.encodeText(Stream.make(stdin)), child.stdin).pipe(
          Effect.mapError(
            (cause) =>
              new ProcessStdinError({
                command: input.command,
                argumentCount: input.args.length,
                cwd: input.cwd,
                spawnCwd: input.spawnCwd,
                stdinBytes: Buffer.byteLength(stdin),
                cause,
              }),
          ),
        );

  const [stdout, stderr] = yield* Effect.all(
    [
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stdout",
        stream: onStdoutChunk
          ? child.stdout.pipe(Stream.tap((chunk) => Effect.sync(() => onStdoutChunk(chunk))))
          : child.stdout,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
      }),
      collectText({
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        spawnCwd: input.spawnCwd,
        streamName: "stderr",
        stream: child.stderr,
        maxOutputBytes,
        outputMode,
        truncatedMarker,
      }),
      writeStdin,
    ],
    { concurrency: "unbounded" },
  );

  const exitCode = yield* child.exitCode.pipe(
    Effect.mapError(
      (cause) =>
        new ProcessReadError({
          command: input.command,
          argumentCount: input.args.length,
          cwd: input.cwd,
          spawnCwd: input.spawnCwd,
          stream: "exitCode",
          cause,
        }),
    ),
  );

  return {
    stdout: stdout.text,
    stderr: stderr.text,
    code: exitCode,
    timedOut: false,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    stdoutInvalidUtf8: stdout.invalidUtf8,
    stderrInvalidUtf8: stderr.invalidUtf8,
  } satisfies ProcessRunOutput;
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("ProcessRunner.make")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      const env = input.env === undefined ? hostEnvironment : { ...hostEnvironment, ...input.env };
      const generation = yield* ExecutableCacheGeneration;
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
                      if (resolveExecutable(input.command, platform, env) === undefined) {
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
      const executable = resolved.get(key) ?? resolveExecutable(input.command, platform, env);
      if (executable !== undefined) resolved.set(key, executable);
      const result = yield* finalizeRunProcess(
        runProcessCore(
          invocationSpawner,
          executable === undefined ? input : { ...input, command: executable },
        ),
        input,
      );
      if (
        platform === "win32" &&
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

  return ProcessRunner.of({
    run,
  });
});

export const layer = Layer.effect(ProcessRunner, make());
