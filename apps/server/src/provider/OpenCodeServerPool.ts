import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  OpenCodeRuntime,
  type OpenCodeRuntimeError,
  type OpenCodeServerConnection,
  type OpenCodeServerProcess,
} from "./opencodeRuntime.ts";

export interface OpenCodeServerPoolAcquireInput {
  readonly binaryPath: string;
  readonly serverUrl?: string | null;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface OpenCodeServerPool {
  readonly withServer: <A, E, R>(
    input: OpenCodeServerPoolAcquireInput,
    useServer: (server: OpenCodeServerConnection) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | OpenCodeRuntimeError, R>;
}

interface OpenCodeServerPoolState {
  server: OpenCodeServerProcess | null;
  serverScope: Scope.Closeable | null;
  binaryPath: string | null;
  activeUses: number;
  idleCloseFiber: Fiber.Fiber<void, never> | null;
}

const toConnection = (server: OpenCodeServerProcess): OpenCodeServerConnection => ({
  url: server.url,
  processId: server.processId,
  exitCode: server.exitCode,
  external: false,
});

export const makeOpenCodeServerPool = Effect.fn("makeOpenCodeServerPool")(function* (input: {
  readonly idleTtl: Duration.Duration;
}): Effect.fn.Return<OpenCodeServerPool, never, OpenCodeRuntime | Scope.Scope> {
  const openCodeRuntime = yield* OpenCodeRuntime;
  const idleFiberScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Scope.close(scope, Exit.void),
  );
  const mutex = yield* Semaphore.make(1);
  const state: OpenCodeServerPoolState = {
    server: null,
    serverScope: null,
    binaryPath: null,
    activeUses: 0,
    idleCloseFiber: null,
  };

  const closeLocalServer = Effect.fn("OpenCodeServerPool.closeLocalServer")(function* () {
    const scope = state.serverScope;
    state.server = null;
    state.serverScope = null;
    state.binaryPath = null;
    state.activeUses = 0;
    if (scope !== null) {
      yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
    }
  });

  const cancelIdleCloseFiber = Effect.fn("OpenCodeServerPool.cancelIdleCloseFiber")(function* () {
    const idleCloseFiber = state.idleCloseFiber;
    state.idleCloseFiber = null;
    if (idleCloseFiber !== null) {
      yield* Fiber.interrupt(idleCloseFiber).pipe(Effect.ignore);
    }
  });

  const scheduleIdleClose = Effect.fn("OpenCodeServerPool.scheduleIdleClose")(function* (
    server: OpenCodeServerProcess,
  ) {
    yield* cancelIdleCloseFiber();
    const fiber = yield* Effect.sleep(input.idleTtl).pipe(
      Effect.andThen(
        mutex.withPermit(
          Effect.gen(function* () {
            if (state.server !== server || state.activeUses > 0) {
              return;
            }
            state.idleCloseFiber = null;
            yield* closeLocalServer();
          }),
        ),
      ),
      Effect.forkIn(idleFiberScope),
    );
    state.idleCloseFiber = fiber;
  });

  const acquireLocalServer = Effect.fn("OpenCodeServerPool.acquireLocalServer")(function* (
    acquireInput: OpenCodeServerPoolAcquireInput,
  ) {
    return yield* mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();

        const existingServer = state.server;
        if (existingServer !== null) {
          if (state.binaryPath !== acquireInput.binaryPath && state.activeUses === 0) {
            yield* closeLocalServer();
          } else {
            if (state.binaryPath !== acquireInput.binaryPath) {
              yield* Effect.logWarning(
                "OpenCode provider probe server binary path mismatch: requested " +
                  acquireInput.binaryPath +
                  " but active server uses " +
                  state.binaryPath +
                  "; reusing existing server because there are active probes",
              );
            }
            state.activeUses += 1;
            return toConnection(existingServer);
          }
        }

        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const serverScope = yield* Scope.make();
            const startedExit = yield* Effect.exit(
              restore(
                openCodeRuntime
                  .startOpenCodeServerProcess({
                    binaryPath: acquireInput.binaryPath,
                    ...(acquireInput.environment !== undefined
                      ? { environment: acquireInput.environment }
                      : {}),
                  })
                  .pipe(Effect.provideService(Scope.Scope, serverScope)),
              ),
            );
            if (startedExit._tag === "Failure") {
              yield* Scope.close(serverScope, Exit.void).pipe(Effect.ignore);
              return yield* Effect.failCause(startedExit.cause);
            }

            const server = startedExit.value;
            state.server = server;
            state.serverScope = serverScope;
            state.binaryPath = acquireInput.binaryPath;
            state.activeUses = 1;
            return toConnection(server);
          }),
        );
      }),
    );
  });

  const releaseLocalServer = Effect.fn("OpenCodeServerPool.releaseLocalServer")(function* (
    server: OpenCodeServerConnection,
  ) {
    yield* mutex.withPermit(
      Effect.gen(function* () {
        if (state.server === null || state.server.url !== server.url) {
          return;
        }
        state.activeUses = Math.max(0, state.activeUses - 1);
        if (state.activeUses === 0) {
          yield* scheduleIdleClose(state.server);
        }
      }),
    );
  });

  yield* Effect.addFinalizer(() =>
    mutex.withPermit(
      Effect.gen(function* () {
        yield* cancelIdleCloseFiber();
        yield* closeLocalServer();
      }),
    ),
  );

  const withServer: OpenCodeServerPool["withServer"] = (acquireInput, useServer) => {
    const serverUrl = acquireInput.serverUrl?.trim();
    if (serverUrl) {
      return useServer({
        url: serverUrl,
        processId: null,
        exitCode: null,
        external: true,
      });
    }

    return Effect.acquireUseRelease(
      acquireLocalServer(acquireInput),
      useServer,
      releaseLocalServer,
    );
  };

  return { withServer } satisfies OpenCodeServerPool;
});
