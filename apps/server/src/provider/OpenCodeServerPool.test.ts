import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import { makeOpenCodeServerPool, type OpenCodeServerPool } from "./OpenCodeServerPool.ts";
import { OpenCodeRuntime, type OpenCodeRuntimeShape } from "./opencodeRuntime.ts";

const IDLE_TTL_MS = 10_000;

const runtimeMock = {
  state: {
    startCalls: [] as Array<string>,
    closeCalls: [] as Array<string>,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.closeCalls.length = 0;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      const index = runtimeMock.state.startCalls.length + 1;
      const url = `http://127.0.0.1:${4_300 + index}`;
      runtimeMock.state.startCalls.push(binaryPath);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
        }),
      );
      return {
        url,
        processId: 4_300 + index,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.succeed({
      url: serverUrl ?? "http://127.0.0.1:4301",
      processId: null,
      exitCode: null,
      external: Boolean(serverUrl),
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    ({}) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.succeed({
      providerList: { connected: [], all: [], default: {} },
      agents: [],
    }),
  loadInventoryFromCli: () =>
    Effect.succeed({
      providerList: { connected: [], all: [], default: {} },
      agents: [],
    }),
};

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(NodeServices.layer),
);

const makePool = (): Effect.Effect<OpenCodeServerPool, never, OpenCodeRuntime | Scope.Scope> =>
  makeOpenCodeServerPool({ idleTtl: Duration.millis(IDLE_TTL_MS) });

const withPool = <A, E, R>(effectFn: (pool: OpenCodeServerPool) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const pool = yield* makePool();
    return yield* effectFn(pool);
  }).pipe(Effect.scoped);

const advanceIdleClock = Effect.gen(function* () {
  yield* Effect.yieldNow;
  yield* TestClock.adjust(Duration.millis(IDLE_TTL_MS + 1));
  yield* Effect.yieldNow;
});

beforeEach(() => {
  runtimeMock.reset();
});

it.layer(testLayer)("OpenCodeServerPool", (it) => {
  it.effect("reuses a warm local server and closes it after idling", () =>
    withPool((pool) =>
      Effect.gen(function* () {
        const firstUrl = yield* pool.withServer({ binaryPath: "fake-opencode" }, (server) =>
          Effect.succeed(server.url),
        );
        const secondUrl = yield* pool.withServer({ binaryPath: "fake-opencode" }, (server) =>
          Effect.succeed(server.url),
        );

        NodeAssert.equal(firstUrl, "http://127.0.0.1:4301");
        NodeAssert.equal(secondUrl, firstUrl);
        NodeAssert.deepEqual(runtimeMock.state.startCalls, ["fake-opencode"]);
        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

        yield* advanceIdleClock;

        NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels a pending idle close when the server is reused", () =>
    withPool((pool) =>
      Effect.gen(function* () {
        const firstUrl = yield* pool.withServer({ binaryPath: "fake-opencode" }, (server) =>
          Effect.succeed(server.url),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(IDLE_TTL_MS / 2));
        yield* Effect.yieldNow;

        const secondUrl = yield* pool.withServer({ binaryPath: "fake-opencode" }, (server) =>
          Effect.succeed(server.url),
        );

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(IDLE_TTL_MS / 2 + 1));
        yield* Effect.yieldNow;

        NodeAssert.equal(secondUrl, firstUrl);
        NodeAssert.deepEqual(runtimeMock.state.startCalls, ["fake-opencode"]);
        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

        yield* advanceIdleClock;

        NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the local server alive until all concurrent users release it", () =>
    withPool((pool) =>
      Effect.gen(function* () {
        const firstUseStarted = yield* Deferred.make<string>();
        const releaseFirstUse = yield* Deferred.make<void>();

        const firstFiber = yield* pool
          .withServer({ binaryPath: "fake-opencode" }, (server) =>
            Deferred.succeed(firstUseStarted, server.url).pipe(
              Effect.andThen(Deferred.await(releaseFirstUse)),
            ),
          )
          .pipe(Effect.forkScoped);

        const firstUrl = yield* Deferred.await(firstUseStarted);
        const secondUrl = yield* pool.withServer({ binaryPath: "fake-opencode" }, (server) =>
          Effect.succeed(server.url),
        );

        NodeAssert.equal(secondUrl, firstUrl);
        NodeAssert.deepEqual(runtimeMock.state.startCalls, ["fake-opencode"]);
        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.millis(IDLE_TTL_MS + 1));
        yield* Effect.yieldNow;

        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

        yield* Deferred.succeed(releaseFirstUse, undefined);
        yield* Fiber.join(firstFiber);
        yield* advanceIdleClock;

        NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:4301"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("bypasses local process management for an external server URL", () =>
    withPool((pool) =>
      Effect.gen(function* () {
        const server = yield* pool.withServer(
          {
            binaryPath: "fake-opencode",
            serverUrl: " http://127.0.0.1:9999 ",
          },
          (connection) => Effect.succeed(connection),
        );

        NodeAssert.equal(server.url, "http://127.0.0.1:9999");
        NodeAssert.equal(server.external, true);
        NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);

        yield* advanceIdleClock;

        NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("closes the local server when the owning scope closes", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pool = yield* makePool();
          yield* pool.withServer({ binaryPath: "fake-opencode" }, () => Effect.void);

          NodeAssert.deepEqual(runtimeMock.state.closeCalls, []);
        }),
      );

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, ["http://127.0.0.1:4301"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
