// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The rollback test waits in real time for real state files under TestClock.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

interface UpdatesHarnessOptions {
  readonly checkForUpdates?: Effect.Effect<
    void,
    ElectronUpdater.ElectronUpdaterCheckForUpdatesError
  >;
  readonly setUpdateChannelError?: DesktopAppSettings.DesktopSettingsWriteError;
  readonly setDisableDifferentialDownload?: Effect.Effect<void>;
  readonly stopBackend?: Effect.Effect<void>;
  readonly env?: Record<string, string | undefined>;
  readonly environment?: Partial<DesktopEnvironment.MakeDesktopEnvironmentInput>;
}

function makeHarness(options: UpdatesHarnessOptions = {}) {
  let checkCount = 0;
  let allowDowngrade = false;
  let fullChangelog = false;
  const feedUrls: ElectronUpdater.ElectronUpdaterFeedUrl[] = [];
  const listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();
  const sentStates: DesktopUpdateState[] = [];
  let backendReady = false;

  const addListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName) ?? new Set();
    eventListeners.add(listener);
    listeners.set(eventName, eventListeners);
  };

  const removeListener = (eventName: string, listener: (...args: readonly unknown[]) => void) => {
    const eventListeners = listeners.get(eventName);
    if (!eventListeners) {
      return;
    }
    eventListeners.delete(listener);
    if (eventListeners.size === 0) {
      listeners.delete(eventName);
    }
  };

  const updaterLayer = Layer.succeed(ElectronUpdater.ElectronUpdater, {
    setFeedURL: (options) =>
      Effect.sync(() => {
        feedUrls.push(options);
      }),
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: (value) =>
      Effect.sync(() => {
        fullChangelog = value;
      }),
    setDisableDifferentialDownload: () => options.setDisableDifferentialDownload ?? Effect.void,
    checkForUpdates: Effect.sync(() => {
      checkCount += 1;
    }).pipe(Effect.andThen(options.checkForUpdates ?? Effect.void)),
    downloadUpdate: Effect.void,
    quitAndInstall: () => Effect.void,
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          addListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
        }),
        () =>
          Effect.sync(() => {
            removeListener(eventName, listener as unknown as (...args: readonly unknown[]) => void);
          }),
      ).pipe(Effect.asVoid),
  } satisfies ElectronUpdater.ElectronUpdater["Service"]);

  const windowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
    create: () => Effect.die("unexpected BrowserWindow creation"),
    main: Effect.succeed(Option.none()),
    currentMainOrFirst: Effect.succeed(Option.none()),
    focusedMainOrFirst: Effect.succeed(Option.none()),
    setMain: () => Effect.void,
    clearMain: () => Effect.void,
    prepareReveal: () => Effect.succeed(false),
    reveal: () => Effect.void,
    sendAll: (_channel, state) =>
      Effect.sync(() => {
        sentStates.push(state as DesktopUpdateState);
      }),
    destroyAll: Effect.void,
    syncAllAppearance: () => Effect.void,
  } satisfies ElectronWindow.ElectronWindow["Service"]);

  const stubBackendInstance: DesktopBackendPool.DesktopBackendInstance = {
    id: DesktopBackendPool.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    start: Effect.void,
    stop: () => options.stopBackend ?? Effect.void,
    currentConfig: Effect.succeed(Option.none()),
    snapshot: Effect.sync(() => ({
      desiredRunning: false,
      ready: backendReady,
      activePid: Option.none(),
      restartAttempt: 0,
      restartScheduled: false,
    })),
    waitForReady: () => Effect.succeed(true),
  };
  const backendLayer = DesktopBackendPool.layerTest([stubBackendInstance]);

  const environmentLayer = DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: NodePath.join(NodeOS.tmpdir(), `t3-desktop-updates-home-${process.pid}`),
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
    ...options.environment,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        DesktopConfig.layerTest({
          T3CODE_HOME: NodePath.join(NodeOS.tmpdir(), `t3-desktop-updates-test-${process.pid}`),
          T3CODE_DESKTOP_MOCK_UPDATES: "true",
          T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
          ...options.env,
        }),
      ),
    ),
  );

  const setUpdateChannelError = options.setUpdateChannelError;
  const settingsLayer = setUpdateChannelError
    ? Layer.succeed(DesktopAppSettings.DesktopAppSettings, {
        get: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        load: Effect.succeed(DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS),
        setLocalEnvironmentEnabled: () => Effect.die("unexpected local environment toggle"),
        setMainWindowBounds: () => Effect.die("unexpected main window bounds update"),
        setServerExposureMode: () => Effect.die("unexpected server exposure update"),
        setTailscaleServe: () => Effect.die("unexpected Tailscale Serve update"),
        setUpdateChannel: () => Effect.fail(setUpdateChannelError),
        setWslBackendEnabled: () => Effect.die("unexpected WSL backend toggle"),
        setWslDistro: () => Effect.die("unexpected WSL distro change"),
        setWslOnly: () => Effect.die("unexpected WSL-only toggle"),
        applyWslWindowsFallback: Effect.die("unexpected WSL Windows fallback"),
        applyWslWindowsFallbackInMemory: Effect.die("unexpected WSL Windows fallback"),
      } satisfies DesktopAppSettings.DesktopAppSettings["Service"])
    : DesktopAppSettings.layer;

  const layer = DesktopUpdates.layer.pipe(
    Layer.provide(
      Layer.mock(ElectronPowerMonitor.ElectronPowerMonitor, {
        getSystemIdleTime: Effect.succeed(0),
      }),
    ),
    Layer.provideMerge(updaterLayer),
    Layer.provideMerge(windowLayer),
    Layer.provideMerge(backendLayer),
    Layer.provideMerge(DesktopState.layer),
    Layer.provideMerge(settingsLayer),
    Layer.provideMerge(
      DesktopConfig.layerTest({
        T3CODE_HOME: NodePath.join(NodeOS.tmpdir(), `t3-desktop-updates-test-${process.pid}`),
        T3CODE_DESKTOP_MOCK_UPDATES: "true",
        T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT: "4141",
        ...options.env,
      }),
    ),
    Layer.provideMerge(environmentLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  return {
    layer,
    setBackendReady: (ready: boolean) => {
      backendReady = ready;
    },
    checkCount: () => checkCount,
    feedUrls: () => feedUrls,
    fullChangelog: () => fullChangelog,
    listenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, eventListeners) => total + eventListeners.size,
        0,
      ),
    sentStates,
    emit: (eventName: string, payload?: unknown) => {
      for (const listener of listeners.get(eventName) ?? []) {
        listener(payload);
      }
    },
  };
}

describe("DesktopUpdates", () => {
  it.effect("disables updates with a visible reason for packaged Fork Dev builds", () => {
    const harness = makeHarness({
      environment: {
        desktopFlavor: "dev",
      },
    });

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;

        const state = yield* updates.getState;
        assert.equal(state.enabled, false);
        assert.equal(state.status, "disabled");
        assert.equal(state.message, "Automatic updates are disabled for Fork Dev builds.");
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect(
    "never offers a rolled-back version and marks healthy once the backend is ready",
    () => {
      const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-update-rollback-"));
      const rollbackDir = NodePath.join(home, "userdata", "update-rollback");
      NodeFS.mkdirSync(rollbackDir, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(rollbackDir, "rolled-back.json"),
        '{"version":"1.2.4","previousVersion":"1.2.3","outcome":"rolled-back","notified":true}',
      );
      const harness = makeHarness({
        env: { T3CODE_HOME: home },
        environment: { resourcesPath: NodePath.join(home, "T3 Code.app", "Contents", "Resources") },
      });
      const healthFile = NodePath.join(rollbackDir, "healthy-version");
      // writeFile creates the marker before its bytes land, so waiting on
      // existsSync can read a truncated file on a loaded runner. The written
      // version is the readiness signal.
      const readHealthyVersion = () => {
        try {
          return NodeFS.readFileSync(healthFile, "utf8");
        } catch {
          return "";
        }
      };

      return Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* DesktopUpdates.DesktopUpdates;
          yield* updates.configure;

          harness.emit("update-available", { version: "1.2.4" });
          yield* Effect.yieldNow;
          assert.equal((yield* updates.getState).status, "up-to-date");

          harness.emit("update-available", { version: "1.2.5" });
          yield* Effect.yieldNow;
          assert.equal((yield* updates.getState).availableVersion, "1.2.5");

          const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
          yield* TestClock.adjust("1 minute");
          yield* settle;
          assert.isFalse(NodeFS.existsSync(healthFile));

          harness.setBackendReady(true);
          yield* TestClock.adjust("1 second");
          for (let attempt = 0; attempt < 100 && readHealthyVersion() === ""; attempt += 1) {
            yield* settle;
          }
          assert.equal(readHealthyVersion(), "1.2.3");
        }),
      ).pipe(
        Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true }))),
      );
    },
  );
});

// A stand-in for ~/t3-mac-dev/dev-launch.sh: `head` is the checkout, `tip` is origin, and an
// update request moves head to tip unless the kit is told to fail.
function makeKitHome(options: {
  readonly head: string;
  readonly tip: string;
  readonly failBuild?: boolean;
  /** The kit worker never finishes: --status reports it running. */
  readonly stuck?: boolean;
  /** Report the build the way newer kits do, as `verified app revision:` instead of `checkout:`. */
  readonly verified?: string;
  /** The checkout catches up on this --status call, as when the app relaunches after an overrun. */
  readonly catchUpAtStatusCall?: number;
}) {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devkit-home-"));
  const kitDir = NodePath.join(home, "t3-mac-dev");
  NodeFS.mkdirSync(kitDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(kitDir, "head"), options.head);
  NodeFS.writeFileSync(NodePath.join(kitDir, "tip"), options.tip);
  NodeFS.writeFileSync(
    NodePath.join(kitDir, "dev-launch.sh"),
    `dir="$(cd "$(dirname "$0")" && pwd)"
head="$(cat "$dir/head")"; tip="$(cat "$dir/tip")"
if [ "$1" = "--status" ]; then
  calls=$(( $(cat "$dir/calls" 2>/dev/null || echo 0) + 1 )); echo $calls >"$dir/calls"
  ${options.catchUpAtStatusCall ? `[ $calls -ge ${options.catchUpAtStatusCall} ] && cp "$dir/tip" "$dir/head" && head="$tip"` : "true"}
  echo "branch followed: live   fetched: yes"
  ${options.verified ? `echo "verified app revision: ${options.verified}"` : 'echo "checkout:        $head on live"'}
  echo "origin/live:  $tip"
  echo "dev app running: yes   update worker: ${options.stuck ? "running" : "idle"}"
  if [ "$head" = "$tip" ]; then echo "needs update:    no"; else echo "needs update:    yes (automatic updater will apply it)"; fi
else
  echo requested >>"$dir/requests"
  ${options.failBuild ? "true" : 'cp "$dir/tip" "$dir/head"'}
fi
`,
  );
  const logDir = NodePath.join(home, ".t3-code-dev-kit");
  return {
    home,
    appendLog: (text: string) => {
      NodeFS.mkdirSync(logDir, { recursive: true });
      NodeFS.appendFileSync(NodePath.join(logDir, "launch.log"), text);
    },
    requests: () => {
      try {
        return NodeFS.readFileSync(NodePath.join(kitDir, "requests"), "utf8").trim().split("\n")
          .length;
      } catch {
        return 0;
      }
    },
    environment: {
      homeDirectory: home,
      isPackaged: false,
      dirname: NodePath.join(home, "Developer", "t3code-dev", "apps", "desktop", "src"),
    },
    env: { VITE_DEV_SERVER_URL: "http://localhost:5733" },
  };
}

const devKitHarness = (kit: ReturnType<typeof makeKitHome>) =>
  makeHarness({ environment: kit.environment, env: kit.env });

describe("DesktopUpdates in the Mac dev kit app", () => {
  it.effect("checks origin/live against the build and shows both short SHAs", () => {
    const kit = makeKitHome({ head: "abc1234", tip: "def5678" });
    const harness = devKitHarness(kit);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal((yield* updates.getState).enabled, true);

        const behind = yield* updates.check("test");
        assert.equal(behind.checked, true);
        assert.equal(behind.state.status, "available");
        assert.equal(behind.state.availableVersion, "def5678");
        assert.include(behind.state.message, "abc1234");
        assert.include(behind.state.message, "def5678");

        NodeFS.writeFileSync(NodePath.join(kit.home, "t3-mac-dev", "tip"), "abc1234");
        const current = yield* updates.check("test");
        assert.equal(current.state.status, "up-to-date");
        assert.include(current.state.message, "abc1234");
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(kit.home, { recursive: true, force: true }))),
    );
  });

  const runUpdate = (updates: DesktopUpdates.DesktopUpdates["Service"]) =>
    Effect.gen(function* () {
      const finished = { value: false };
      const fiber = yield* Effect.forkChild(
        updates.startUpdate.pipe(Effect.tap(() => Effect.sync(() => (finished.value = true)))),
      );
      for (let attempt = 0; attempt < 200 && !finished.value; attempt += 1) {
        yield* TestClock.adjust("10 seconds");
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
      }
      return yield* Fiber.join(fiber);
    });

  it.effect("updates by asking the kit to rebuild and reports the result", () => {
    const kit = makeKitHome({ head: "abc1234", tip: "def5678" });
    const harness = devKitHarness(kit);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* runUpdate(updates);
        assert.equal(kit.requests(), 1);
        assert.equal(result.completed, true);
        assert.equal(result.state.status, "up-to-date");
        assert.equal(
          harness.sentStates.some(
            (state) => state.updatePhase === "installing" && state.message?.includes("Rebuilding"),
          ),
          true,
        );
        assert.equal(harness.checkCount(), 0);
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(kit.home, { recursive: true, force: true }))),
    );
  });

  const settle = Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 30)));

  it.effect("shows the kit's step and progress, and says plainly when the log goes quiet", () => {
    const kit = makeKitHome({ head: "abc1234", tip: "def5678", stuck: true });
    kit.appendLog("==> Updating an earlier run\nProgress: resolved 99, reused 99\n");
    const harness = devKitHarness(kit);
    const realNow = Date.now();
    const messages = () =>
      harness.sentStates.flatMap((state) => (state.message === null ? [] : [state.message]));
    return Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(realNow);
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        yield* updates.check("test");
        const fiber = yield* Effect.forkChild(updates.startUpdate);
        for (let attempt = 0; attempt < 100 && kit.requests() === 0; attempt += 1) {
          yield* settle;
        }
        kit.appendLog(
          "\n==> Installing dependencies (vp i)\nProgress: resolved 12, reused 10, downloaded 0\n",
        );
        yield* TestClock.adjust("5 seconds");
        yield* settle;
        const live = messages().findLast((message) => message.includes("Installing dependencies"));
        assert.include(live, "resolved 12, reused 10");
        assert.include(live, "5s elapsed");
        assert.include(live, "last activity");
        assert.notInclude(live, "earlier run");
        assert.notInclude(live, "may be stuck");

        // The log stays silent: 25 more ticks is past the two quiet minutes.
        for (let tick = 0; tick < 25; tick += 1) {
          yield* TestClock.adjust("5 seconds");
          yield* settle;
        }
        const stuck = messages().findLast((message) => message.includes("may be stuck"));
        assert.include(stuck, "No log activity for");
        assert.include(stuck, "launch.log");
        yield* Fiber.interrupt(fiber);
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(kit.home, { recursive: true, force: true }))),
    );
  });

  it.effect("does not turn the kit's deadline overrun into an error once the app caught up", () => {
    const kit = makeKitHome({
      head: "abc1234",
      tip: "def5678",
      failBuild: true,
      catchUpAtStatusCall: 3,
    });
    kit.appendLog("==> Updating\n");
    const harness = devKitHarness(kit);
    const realNow = Date.now();
    return Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(realNow);
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* runUpdate(updates);
        assert.equal(result.completed, true);
        assert.equal(result.state.status, "up-to-date");
        assert.equal(
          harness.sentStates.some((state) => state.status === "error"),
          false,
        );
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(kit.home, { recursive: true, force: true }))),
    );
  });

  it.effect("reports a retryable error when the rebuild leaves the app behind", () => {
    const kit = makeKitHome({ head: "abc1234", tip: "def5678", failBuild: true });
    const harness = devKitHarness(kit);
    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        const result = yield* runUpdate(updates);
        assert.equal(result.completed, false);
        assert.equal(result.state.status, "error");
        assert.equal(result.state.errorContext, "install");
        assert.equal(result.state.canRetry, true);
      }),
    ).pipe(
      Effect.provide(Layer.merge(TestClock.layer(), harness.layer)),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(kit.home, { recursive: true, force: true }))),
    );
  });

  it.effect("leaves a dev app from another checkout, or without the kit, disabled", () => {
    const kit = makeKitHome({ head: "abc1234", tip: "def5678" });
    const otherCheckout = makeHarness({
      environment: { ...kit.environment, dirname: "/elsewhere/apps/desktop/src" },
      env: kit.env,
    });
    const noKit = makeKitHome({ head: "abc1234", tip: "def5678" });
    NodeFS.rmSync(NodePath.join(noKit.home, "t3-mac-dev"), { recursive: true });
    const withoutKit = devKitHarness(noKit);
    const disabledState = Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      return yield* updates.getState;
    });
    return Effect.scoped(
      Effect.gen(function* () {
        for (const harness of [otherCheckout, withoutKit]) {
          const state = yield* disabledState.pipe(Effect.provide(harness.layer));
          assert.equal(state.enabled, false);
          assert.equal(
            state.message,
            "Automatic updates are only available in packaged production builds.",
          );
        }
      }),
    ).pipe(
      Effect.provide(TestClock.layer()),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(kit.home, { recursive: true, force: true });
          NodeFS.rmSync(noKit.home, { recursive: true, force: true });
        }),
      ),
    );
  });
});

// A git checkout where the app started on the first commit; origin's tip is the second, which
// changes only `file`.
function makeKitCheckout(home: string, file: string) {
  const checkout = NodePath.join(home, "Developer", "t3code-dev");
  NodeFS.mkdirSync(checkout, { recursive: true });
  const git = (...args: string[]) =>
    NodeChildProcess.execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  NodeFS.writeFileSync(NodePath.join(checkout, "README"), "a");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  const started = git("rev-parse", "HEAD");
  NodeFS.mkdirSync(NodePath.dirname(NodePath.join(checkout, file)), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(checkout, file), "b");
  git("add", "-A");
  git("commit", "-q", "-m", "b");
  const tip = git("rev-parse", "--short=9", "HEAD");
  git("checkout", "-q", "--detach", started);
  return { started: started.slice(0, 9), tip };
}

const checkOnce = (harness: ReturnType<typeof devKitHarness>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const updates = yield* DesktopUpdates.DesktopUpdates;
      yield* updates.configure;
      return (yield* updates.check("test")).state;
    }),
  ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));

describe("DesktopUpdates dev kit Check trusts the app's own commit", () => {
  const withKit = (
    file: string,
    options: (c: { started: string; tip: string }) => Parameters<typeof makeKitHome>[0],
    assertState: (state: DesktopUpdateState, c: { started: string; tip: string }) => void,
  ) => {
    const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-devkit-git-"));
    const commits = makeKitCheckout(scratch, file);
    const kit = makeKitHome(options(commits));
    // The kit home is separate; move the checkout under it so the app finds its own HEAD.
    NodeFS.cpSync(NodePath.join(scratch, "Developer"), NodePath.join(kit.home, "Developer"), {
      recursive: true,
    });
    return checkOnce(devKitHarness(kit)).pipe(
      Effect.map((state) => assertState(state, commits)),
      Effect.ensuring(
        Effect.sync(() => {
          NodeFS.rmSync(kit.home, { recursive: true, force: true });
          NodeFS.rmSync(scratch, { recursive: true, force: true });
        }),
      ),
    );
  };

  it.effect(
    "is up to date when the kit's verified revision is stale but the app is at origin",
    () =>
      withKit(
        "apps/desktop/src/x.ts",
        (c) => ({
          head: "ffe290adc",
          tip: c.started,
          verified: "ffe290adc2629b42f4a9ca4d3a3c40e6a51f7e05",
        }),
        (state, c) => {
          assert.equal(state.status, "up-to-date");
          assert.include(state.message, c.started);
          assert.notInclude(state.message, "ahead");
        },
      ),
  );

  it.effect("is behind, with both SHAs, when origin changed code the app was built without", () =>
    withKit(
      "apps/desktop/src/x.ts",
      (c) => ({
        head: "ffe290adc",
        tip: c.tip,
        verified: "ffe290adc2629b42f4a9ca4d3a3c40e6a51f7e05",
      }),
      (state, c) => {
        assert.equal(state.status, "available");
        assert.equal(
          state.message,
          `origin/live is at ${c.tip}, ahead of this build (${c.started}).`,
        );
      },
    ),
  );

  it.effect("is up to date when origin only changed files the kit hot-reloads", () =>
    withKit(
      "apps/web/src/y.ts",
      (c) => ({ head: "ffe290adc", tip: c.tip }),
      (state, c) => {
        assert.equal(state.status, "up-to-date");
        assert.include(state.message, "hot-reloads");
        assert.include(state.message, c.tip);
      },
    ),
  );
});
