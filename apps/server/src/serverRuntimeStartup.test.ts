import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_MODEL,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as TestConsole from "effect/testing/TestConsole";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as TestClock from "effect/testing/TestClock";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as ServerConfig from "./config.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { buildPairingUrl, renderTerminalQrCode, ShowStartupCredentials } from "./startupAccess.ts";

it.effect.each(
  (["headless", "browser"] as const).flatMap((startupPresentation) =>
    [undefined, false, true].map((interactive) => ({
      startupPresentation,
      interactive,
      expectation: interactive
        ? "visible on a TTY"
        : interactive === false
          ? "out of noninteractive output"
          : "out of redirected output by default",
    })),
  ),
)(
  "keeps $startupPresentation startup credentials $expectation",
  ({ startupPresentation, interactive }) =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const token = "TEST credential+/=?&";
      const connectionString = "http://127.0.0.1:3773";
      const pairingUrl = buildPairingUrl(connectionString, token);
      const logs: string[] = [];
      const browserTargets: string[] = [];
      const logger = Logger.make(({ fiber, message }) => {
        logs.push(
          JSON.stringify({
            message,
            annotations: fiber.getRef(References.CurrentLogAnnotations),
          }),
        );
      });
      const presentation =
        interactive === undefined
          ? ServerRuntimeStartup.presentStartupAccess
          : ServerRuntimeStartup.presentStartupAccess.pipe(
              Effect.provideService(ShowStartupCredentials, interactive),
            );
      yield* presentation.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(ServerConfig.ServerConfig, {
              ...config,
              mode: "web",
              startupPresentation,
              host: "127.0.0.1",
              port: 3773,
              noBrowser: false,
              devUrl: undefined,
            }),
            Layer.mock(EnvironmentAuth.EnvironmentAuth)({
              issueStartupPairingCredential: () =>
                Effect.succeed({
                  id: "test-startup",
                  credential: token,
                  expiresAt: DateTime.makeUnsafe("2026-10-14T23:59:00Z"),
                }),
              issueStartupPairingUrl: () => Effect.succeed(pairingUrl),
            }),
            Layer.mock(HttpServer.HttpServer)({
              address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
            }),
            Layer.mock(ExternalLauncher.ExternalLauncher)({
              launchBrowser: (target) =>
                Effect.sync(() => {
                  browserTargets.push(target);
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new ExternalLauncher.ExternalLauncherBrowserSpawnError({
                        target,
                        command: "test-browser",
                        args: [target],
                        cause: "test failure",
                      }),
                    ),
                  ),
                ),
            }),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );
      const output = [...(yield* TestConsole.logLines), ...logs].join("\n");
      if (interactive) {
        assert.include(output, pairingUrl);
        if (startupPresentation === "headless") {
          assert.include(output, `Token: ${token}`);
          assert.include(output, renderTerminalQrCode(pairingUrl));
        } else {
          assert.deepEqual(browserTargets, [pairingUrl]);
          assert.include(output, "browser auto-open unavailable");
        }
      } else {
        assert.notInclude(output, token);
        assert.notInclude(output, encodeURIComponent(token));
        assert.notInclude(output, new URLSearchParams({ token }).toString());
        assert.notInclude(output, pairingUrl);
        assert.notInclude(output, renderTerminalQrCode(pairingUrl));
        assert.notMatch(output, /[█▀▄]/);
        assert.notInclude(output, "pairingUrl");
        assert.deepEqual(browserTargets, []);
        assert.include(output, "T3 Code server is ready.");
        assert.include(output, `Connection string: ${connectionString}`);
        assert.include(output, "Pairing is available. Run t3 pair on this server");
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest("/tmp", { prefix: "t3-startup-output-" }).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeServices.layer, TestConsole.layer)),
        ),
      ),
    ),
);

it("uses the canonical Codex model for auto-bootstrap", () => {
  assert.deepEqual(ServerRuntimeStartup.getAutoBootstrapThreadModelSelection(), {
    instanceId: ProviderInstanceId.make("codex"),
    model: DEFAULT_MODEL,
  });
});

it.effect("starts without scanning or rebuilding projection history", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (label: string) => Ref.update(calls, (current) => [...current, label]);

    const result = yield* ServerRuntimeStartup.runOrderedV2StartupPhases({
      importLegacyShells: record("import"),
      recover: record("recover").pipe(Effect.as({ closedRequests: 2 })),
      recoverDelegatedTasks: record("delegated"),
      startEffectWorker: record("worker"),
      autoBootstrap: record("bootstrap").pipe(Effect.as({ projectId: "project-1" })),
    });

    // Delegated recovery reads the runs recovery terminalizes, and settles them
    // before the worker runs restart continuations that would otherwise race it.
    assert.deepEqual(yield* Ref.get(calls), [
      "import",
      "recover",
      "delegated",
      "worker",
      "bootstrap",
    ]);
    assert.deepEqual(result, {
      recovery: { closedRequests: 2 },
      bootstrap: { projectId: "project-1" },
    });
  }),
);

it.effect("interrupts the effect worker when awareness relay startup fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const workerInterrupted = yield* Ref.make(false);
      const workerFiberRef = yield* Ref.make<Fiber.Fiber<void, never> | null>(null);

      const exit = yield* ServerRuntimeStartup.startEffectWorkerWithRelay({
        runWorker: Effect.never.pipe(Effect.ensuring(Ref.set(workerInterrupted, true))),
        startRelay: Effect.yieldNow.pipe(
          Effect.andThen(Effect.die("awareness relay startup failed")),
        ),
        workerFiberRef,
      }).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.isTrue(yield* Ref.get(workerInterrupted));
      assert.isNull(yield* Ref.get(workerFiberRef));
    }),
  ),
);

it.effect("queues commands until startup signals readiness", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const count = yield* Ref.make(0);
      const queued = yield* gate
        .enqueueCommand(Ref.updateAndGet(count, (value) => value + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(count), 0);
      yield* gate.signalCommandReady;
      assert.equal(yield* Fiber.join(queued), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* ServerRuntimeStartup.makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartup.ServerRuntimeStartupError({
          mode: "web",
          host: "127.0.0.1",
          port: 3773,
          cause: new Error("test startup failure"),
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "Server runtime startup failed before command readiness.");
    }),
  ),
);

it.effect("resolveWelcomeBase derives cwd and project name from server config", () =>
  Effect.gen(function* () {
    const welcome = yield* ServerRuntimeStartup.resolveWelcomeBase.pipe(
      Effect.provideService(ServerConfig.ServerConfig, {
        cwd: "/tmp/startup-project",
      } as never),
    );

    assert.deepStrictEqual(welcome, {
      cwd: "/tmp/startup-project",
      projectName: "startup-project",
    });
  }),
);

it.effect("automatic pull only updates enabled, behind, clean default-branch checkouts", () =>
  Effect.gen(function* () {
    const pulled: string[] = [];
    const git = {
      statusDetails: (cwd: string) =>
        Effect.succeed({
          isRepo: true,
          isDefaultBranch: cwd !== "/feature",
          hasUpstream: true,
          hasWorkingTreeChanges: cwd === "/dirty",
          aheadCount: cwd === "/ahead" ? 1 : 0,
          behindCount: cwd === "/current" ? 0 : 1,
        } as never),
      pullCurrentBranch: (cwd: string) =>
        Effect.sync(() => {
          pulled.push(cwd);
          return {
            status: "pulled" as const,
            refName: "main",
            upstreamRef: "origin/main",
          };
        }),
    } as unknown as GitVcsDriver.GitVcsDriver["Service"];
    const project = (workspaceRoot: string) =>
      ({ id: ProjectId.make(workspaceRoot), workspaceRoot }) as never;
    const overrides = (entries: Record<string, boolean>) => ({
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: Object.fromEntries(
        Object.entries(entries).map(([root, defaultAutoPull]) => [
          ProjectId.make(root),
          { defaultAutoPull },
        ]),
      ),
    });

    yield* ServerRuntimeStartup.autoPullProjects(
      [
        project("/clean"),
        project("/current"),
        project("/dirty"),
        project("/ahead"),
        project("/feature"),
        project("/disabled"),
      ],
      overrides({
        "/clean": true,
        "/current": true,
        "/dirty": true,
        "/ahead": true,
        "/feature": true,
        "/disabled": false,
      }),
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));

    assert.deepStrictEqual(pulled, ["/clean"]);

    pulled.length = 0;
    yield* ServerRuntimeStartup.autoPullProjects(
      [project("/inherited"), project("/opted-out"), project("/dirty")],
      { ...overrides({ "/opted-out": false }), defaultAutoPull: true },
    ).pipe(Effect.provideService(GitVcsDriver.GitVcsDriver, git));
    assert.deepStrictEqual(pulled, ["/inherited"]);
  }),
);

it.effect("bounds shutdown even inside an uninterruptible finalizer", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const phases = yield* Ref.make<ReadonlyArray<string>>([]);
    const shutdown = yield* ServerRuntimeStartup.runBoundedShutdown(
      [
        {
          name: "stuck-adapter",
          run: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.uninterruptible,
          ),
        },
        { name: "reconcile", run: Ref.update(phases, (xs) => [...xs, "reconcile"]) },
      ],
      100,
    ).pipe(Effect.uninterruptible, Effect.forkScoped);
    yield* Deferred.await(started);
    yield* TestClock.adjust(100);
    assert.isFalse(yield* Fiber.join(shutdown));
    assert.deepEqual(yield* Ref.get(phases), []);
    yield* Deferred.succeed(release, undefined);
  }),
);

it.effect("completes ordered shutdown reconciliation within its budget", () =>
  Effect.gen(function* () {
    const phases = yield* Ref.make<ReadonlyArray<string>>([]);
    assert.isTrue(
      yield* ServerRuntimeStartup.runBoundedShutdown(
        [
          { name: "sessions", run: Ref.update(phases, (xs) => [...xs, "sessions"]) },
          { name: "reconcile", run: Ref.update(phases, (xs) => [...xs, "reconcile"]) },
        ],
        100,
      ),
    );
    assert.deepEqual(yield* Ref.get(phases), ["sessions", "reconcile"]);
  }),
);

it.effect("still closes sessions and reconciles after shutdown preparation fails", () =>
  Effect.gen(function* () {
    const reconciled = yield* Ref.make(false);
    assert.isFalse(
      yield* ServerRuntimeStartup.runBoundedShutdown(
        [
          { name: "prepare", run: Effect.fail("prepare failed") },
          { name: "sessions-and-reconcile", run: Ref.set(reconciled, true) },
        ],
        100,
      ),
    );
    assert.isTrue(yield* Ref.get(reconciled));
  }),
);
