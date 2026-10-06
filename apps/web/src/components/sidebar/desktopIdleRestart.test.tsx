import type { DesktopUpdateState } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  updateState: null as DesktopUpdateState | null,
  boundaryBusy: 0,
}));

vi.mock("./desktopHostedWork", () => ({
  readLocalAgentsBlockingRestart: () => mocks.boundaryBusy,
}));
vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../env")>()),
  isElectron: true,
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

import { DesktopIdleRestartWatcher, useIdleRestartStore } from "./desktopIdleRestart";
import { IDLE_RESTART_GRACE_MS } from "./desktopIdleRestart.logic";

const installUpdate = vi.fn(async () => ({
  accepted: true,
  completed: true,
  state: mocks.updateState,
}));
let renderer: ReactTestRenderer;

function localThread(status: string) {
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

function rerender() {
  act(() => renderer.update(<DesktopIdleRestartWatcher />));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Unit tests run in Node; the watcher reads timers and the bridge from window.
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    desktopBridge: { installUpdate },
  });
  installUpdate.mockClear();
  mocks.boundaryBusy = 0;
  mocks.threads = [localThread("running")];
  mocks.updateState = {
    status: "downloaded",
    downloadedVersion: "0.0.43-nightly.20260924.2187-fork.5",
  } as DesktopUpdateState;
  useIdleRestartStore.setState({
    scheduled: true,
    expectedVersion: mocks.updateState.downloadedVersion,
  });
  act(() => {
    renderer = create(<DesktopIdleRestartWatcher />);
  });
});

afterEach(() => {
  act(() => renderer.unmount());
  useIdleRestartStore.setState({ scheduled: false });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("restarts only after local agents have stayed idle for the grace period", () => {
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS * 2));
  expect(installUpdate).not.toHaveBeenCalled();

  mocks.threads = [localThread("ready")];
  rerender();
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS - 1));
  expect(installUpdate).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(installUpdate).toHaveBeenCalledTimes(1);
  expect(installUpdate).toHaveBeenCalledWith({
    expectedVersion: mocks.updateState?.downloadedVersion,
  });
  expect(useIdleRestartStore.getState().scheduled).toBe(false);
});

it("starts the grace period over when an agent picks up work again", () => {
  mocks.threads = [localThread("ready")];
  rerender();
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS - 1_000));

  mocks.threads = [localThread("running")];
  rerender();
  mocks.threads = [localThread("ready")];
  rerender();
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS - 1));
  expect(installUpdate).not.toHaveBeenCalled();

  act(() => vi.advanceTimersByTime(1));
  expect(installUpdate).toHaveBeenCalledTimes(1);
});

it("never restarts on its own unless a restart was scheduled", () => {
  act(() => useIdleRestartStore.setState({ scheduled: false }));
  mocks.threads = [localThread("ready")];
  rerender();
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS * 4));
  expect(installUpdate).not.toHaveBeenCalled();
});

it("rechecks live work before React renders a new run", () => {
  mocks.threads = [localThread("ready")];
  rerender();
  mocks.boundaryBusy = 1;
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS));
  expect(installUpdate).not.toHaveBeenCalled();
  expect(useIdleRestartStore.getState().scheduled).toBe(true);
});
it("does not install a replacement download under an older schedule", () => {
  mocks.threads = [localThread("ready")];
  mocks.updateState = { ...mocks.updateState!, downloadedVersion: "different-version" };
  rerender();
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS));
  expect(installUpdate).not.toHaveBeenCalled();
});
it("cancellation revokes an armed timer", () => {
  mocks.threads = [localThread("ready")];
  rerender();
  act(() => useIdleRestartStore.getState().cancel());
  act(() => vi.advanceTimersByTime(IDLE_RESTART_GRACE_MS));
  expect(installUpdate).not.toHaveBeenCalled();
});
