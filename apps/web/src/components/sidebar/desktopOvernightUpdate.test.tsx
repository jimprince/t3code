vi.mock("./desktopHostedWork", () => ({ readLocalAgentsBlockingRestart: () => 0 }));
import type { DesktopUpdateState } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  idleSeconds: 0,
  installWhenIdle: true,
  threads: [] as Array<Record<string, unknown>>,
  updateState: null as DesktopUpdateState | null,
}));

vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
}));
vi.mock("../../hooks/useSettings", () => ({
  useClientSettings: () => ({
    installUpdatesWhenIdle: mocks.installWhenIdle,
    updateIdleMinutes: 15,
  }),
  useClientSettingsHydrated: () => true,
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => mocks.threads }));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: [
      { environmentId: "local-env", entry: { target: { _tag: "PrimaryConnectionTarget" } } },
    ],
  }),
}));
vi.mock("../../state/desktopUpdate", () => ({
  useDesktopUpdateState: () => mocks.updateState,
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

import { IDLE_RESTART_GRACE_MS } from "./desktopIdleRestart.logic";
import { DesktopOvernightUpdateWatcher } from "./desktopOvernightUpdate";
import { OVERNIGHT_USER_QUIET_MS } from "./desktopOvernightUpdate.logic";

const result = () => ({ accepted: true, completed: true, state: mocks.updateState });
const downloadUpdate = vi.fn(async () => result());
const installUpdate = vi.fn(async () => result());
const listeners = new Map<string, () => void>();
let renderer: ReactTestRenderer;

function thread(status: string) {
  return {
    environmentId: "local-env",
    id: "thread-1",
    runtime: { status: status === "ready" ? "idle" : status },
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingBackgroundTasks: [],
  };
}

function mount() {
  act(() => {
    renderer = create(<DesktopOvernightUpdateWatcher />);
  });
}

function rerender() {
  act(() => renderer.update(<DesktopOvernightUpdateWatcher />));
}

/** Steps time a second per act() so each clock tick renders, as it does in the app. */
function advance(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    act(() => vi.advanceTimersByTime(Math.min(1_000, left)));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 27, 2, 0));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Unit tests run in Node; the watcher reads timers, input events and the bridge from window.
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    addEventListener: (event: string, listener: () => void) => listeners.set(event, listener),
    removeEventListener: (event: string) => listeners.delete(event),
    desktopBridge: {
      downloadUpdate,
      installUpdate,
      getUpdateState: async () => ({ ...mocks.updateState, systemIdleSeconds: mocks.idleSeconds }),
    },
  });
  downloadUpdate.mockClear();
  installUpdate.mockClear();
  mocks.idleSeconds = 0;
  mocks.installWhenIdle = true;
  mocks.threads = [thread("ready")];
  mocks.updateState = {
    enabled: true,
    status: "downloaded",
    availableVersion: "1.1.0",
    downloadedVersion: "1.1.0",
    errorContext: null,
  } as DesktopUpdateState;
});

afterEach(() => {
  act(() => renderer.unmount());
  listeners.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("downloads an available update as soon as the night starts, once", () => {
  mocks.updateState = { ...mocks.updateState!, status: "available", downloadedVersion: null };
  mount();
  expect(downloadUpdate).toHaveBeenCalledTimes(1);

  advance(OVERNIGHT_USER_QUIET_MS * 2);
  rerender();
  expect(downloadUpdate).toHaveBeenCalledTimes(1);
});

it("installs once agents and the user have been idle, and not again that night", () => {
  mount();
  advance(OVERNIGHT_USER_QUIET_MS);
  expect(installUpdate).not.toHaveBeenCalled();

  advance(IDLE_RESTART_GRACE_MS);
  expect(installUpdate).toHaveBeenCalledTimes(1);

  advance(OVERNIGHT_USER_QUIET_MS * 2);
  expect(installUpdate).toHaveBeenCalledTimes(1);
});

it("waits while the user is using the window or an agent is working", () => {
  mocks.threads = [thread("running")];
  mount();
  advance(OVERNIGHT_USER_QUIET_MS - 60_000);
  act(() => listeners.get("keydown")?.());
  mocks.threads = [thread("ready")];
  rerender();
  advance(OVERNIGHT_USER_QUIET_MS - 1);
  expect(installUpdate).not.toHaveBeenCalled();

  advance(IDLE_RESTART_GRACE_MS + 30_000);
  expect(installUpdate).toHaveBeenCalledTimes(1);
});

it("leaves updates alone during the day", () => {
  vi.setSystemTime(new Date(2026, 8, 27, 14, 0));
  mount();
  advance(OVERNIGHT_USER_QUIET_MS * 3);
  expect(installUpdate).not.toHaveBeenCalled();
  expect(downloadUpdate).not.toHaveBeenCalled();
});

it("installs an idle daytime update through the guarded install path and cancels on input", async () => {
  vi.setSystemTime(new Date(2026, 8, 27, 14, 0));
  mocks.idleSeconds = 900;
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  act(() => listeners.get("keydown")?.());
  mocks.idleSeconds = 0;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_RESTART_GRACE_MS);
  });
  expect(installUpdate).not.toHaveBeenCalled();
  mocks.idleSeconds = 900;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(IDLE_RESTART_GRACE_MS);
  });
  expect(installUpdate).toHaveBeenCalledWith({
    expectedVersion: "1.1.0",
    minimumSystemIdleSeconds: 900,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(OVERNIGHT_USER_QUIET_MS);
  });
  expect(installUpdate).toHaveBeenCalledTimes(1);
});

it("keeps an opted-out daytime watcher idle even when system and agents are idle", async () => {
  vi.setSystemTime(new Date(2026, 8, 27, 14, 0));
  mocks.idleSeconds = 900;
  mocks.installWhenIdle = false;
  mount();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(OVERNIGHT_USER_QUIET_MS);
  });
  expect(installUpdate).not.toHaveBeenCalled();
});
