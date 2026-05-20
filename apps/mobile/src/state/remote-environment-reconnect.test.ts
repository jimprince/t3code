import { afterEach, describe, expect, it, vi } from "vitest";

import type { EnvironmentRuntimeState } from "@t3tools/client-runtime";

import {
  createShellResumeWatchdog,
  deriveRuntimeStateForConnectionAttempt,
  deriveRuntimeStateForSocketOpen,
} from "./remote-environment-reconnect";

const BASE_RUNTIME: EnvironmentRuntimeState = {
  connectionState: "idle",
  connectionError: null,
  serverConfig: null,
};

function runtime(
  connectionState: EnvironmentRuntimeState["connectionState"],
  connectionError: string | null = null,
): EnvironmentRuntimeState {
  return {
    ...BASE_RUNTIME,
    connectionState,
    connectionError,
  };
}

describe("mobile remote environment reconnect state", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears stale disconnected socket errors when a fresh connection attempt starts", () => {
    const next = deriveRuntimeStateForConnectionAttempt(
      runtime("disconnected", "The operation couldn't be completed. Socket is not connected"),
    );

    expect(next).toMatchObject({
      connectionState: "reconnecting",
      connectionError: null,
    });
  });

  it("does not mark an environment ready from a WebSocket attempt or open", () => {
    expect(deriveRuntimeStateForConnectionAttempt(runtime("ready")).connectionState).toBe(
      "reconnecting",
    );
    expect(
      deriveRuntimeStateForSocketOpen(runtime("disconnected", "Socket is not connected")),
    ).toMatchObject({
      connectionState: "reconnecting",
      connectionError: null,
    });
  });

  it("uses connecting for the first bootstrap attempt", () => {
    expect(deriveRuntimeStateForConnectionAttempt(runtime("idle"))).toMatchObject({
      connectionState: "connecting",
      connectionError: null,
    });
  });

  it("fires a shell-resume timeout only while runtime is still waiting for a snapshot", () => {
    vi.useFakeTimers();
    let currentRuntime = runtime("reconnecting");
    const markPending = vi.fn();
    const onTimeout = vi.fn();
    const watchdog = createShellResumeWatchdog({
      timeoutMs: 100,
      getRuntimeState: () => currentRuntime,
      markPending,
      onTimeout,
    });

    watchdog.schedule();
    expect(markPending).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(99);
    expect(onTimeout).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledOnce();

    onTimeout.mockClear();
    watchdog.schedule();
    currentRuntime = runtime("ready");
    vi.advanceTimersByTime(100);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("ignores stale watchdog generations after a shell snapshot sync", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const watchdog = createShellResumeWatchdog({
      timeoutMs: 100,
      getRuntimeState: () => runtime("reconnecting"),
      markPending: vi.fn(),
      onTimeout,
    });

    watchdog.schedule();
    watchdog.markShellSnapshotSynced();
    vi.advanceTimersByTime(100);

    expect(onTimeout).not.toHaveBeenCalled();
  });
});
