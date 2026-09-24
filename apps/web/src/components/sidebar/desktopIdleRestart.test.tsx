import type { DesktopUpdateState } from "@t3tools/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  threads: [] as Array<Record<string, unknown>>,
  updateState: null as DesktopUpdateState | null,
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
    session: { status },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    backgroundLiveness: null,
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
  mocks.threads = [localThread("running")];
  mocks.updateState = {
    status: "downloaded",
    downloadedVersion: "0.0.43-nightly.20260924.2187-fork.5",
  } as DesktopUpdateState;
  useIdleRestartStore.setState({ scheduled: true });
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
