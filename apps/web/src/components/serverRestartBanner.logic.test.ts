import {
  applyServerRestartEvent,
  disconnectServerRestart,
  expireServerRestart,
  SERVER_RESTART_TIMEOUT_MS,
  type ServerRestartState,
} from "@t3tools/client-runtime/fork/server-restart";
import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeServerRestart,
  serverRestartClearDelayMs,
  serverRestartExpiryDelayMs,
  serverRestartReconnected,
} from "./serverRestartBanner.logic";

const updating = (extra: Partial<Extract<ServerRestartState, { status: "updating" }>> = {}) =>
  ({
    status: "updating",
    targetVersion: "0.0.46-nightly.20261008.1-fork.6",
    announcedAt: "2026-10-08T20:00:00.000Z",
    phase: "installing",
    etaSeconds: 30,
    ...extra,
  }) satisfies ServerRestartState;

describe("server restart banner", () => {
  it("walks installing, restarting and reconnecting, then confirms the new version", () => {
    expect(describeServerRestart(updating(), null)).toMatchObject({
      title: "Server updating to fork.6",
      detail: "back in about 30 s",
      stepsDone: 0,
    });
    expect(describeServerRestart(updating({ phase: "restarting" }), null)?.stepsDone).toBe(1);
    expect(describeServerRestart(updating({ deadline: 1_000 }), null)).toMatchObject({
      title: "Server restarted",
      detail: "reconnecting automatically",
      stepsDone: 2,
    });
    expect(
      describeServerRestart(
        { ...updating(), status: "updated", serverVersion: "0.0.46-nightly.20261008.1-fork.6" },
        null,
      ),
    ).toMatchObject({ tone: "done", title: "Server updated to fork.6", stepsDone: null });
  });

  it("offers Retry and the manual command once the server did not come back", () => {
    const failed: ServerRestartState = {
      status: "failed",
      targetVersion: "0.0.46-nightly.20261008.1-fork.6",
      announcedAt: "2026-10-08T20:00:00.000Z",
      reason: "Server did not come back",
      manualUpdateCommand: "npx t3@latest",
    };
    expect(describeServerRestart(failed, "Build box")).toMatchObject({
      tone: "failed",
      title: "Build box: Server did not come back",
      manualUpdateCommand: "npx t3@latest",
      canRetry: true,
    });
  });

  it("clears a finished restart after four seconds and expires a lost server at its deadline", () => {
    expect(serverRestartClearDelayMs({ ...updating(), status: "back", serverVersion: "x" })).toBe(
      4_000,
    );
    expect(serverRestartClearDelayMs(updating())).toBeNull();
    expect(serverRestartExpiryDelayMs(updating({ deadline: 91_000 }), 10_000)).toBe(81_000);
    expect(serverRestartExpiryDelayMs(updating({ deadline: 91_000 }), 95_000)).toBe(0);
    expect(serverRestartExpiryDelayMs(updating(), 10_000)).toBeNull();
  });

  describe("a lost connection during the install", () => {
    const announced: ServerLifecycleStreamEvent = {
      version: 1,
      sequence: 2,
      type: "updating",
      payload: {
        at: "2026-10-08T20:00:00.000Z",
        targetVersion: "0.0.46-nightly.20261008.1-fork.6",
        phase: "installing",
        etaSeconds: 30,
      },
    };
    const installing = applyServerRestartEvent({ status: "idle" }, announced);

    it("does not fail when the connection returns, even after the replayed update event", () => {
      const lost = disconnectServerRestart(installing, 1_000);
      const back = applyServerRestartEvent(serverRestartReconnected(lost), announced);
      expect(back.status).toBe("updating");
      expect(expireServerRestart(back, 1_000 + SERVER_RESTART_TIMEOUT_MS + 60_000)).toBe(back);
      expect(serverRestartExpiryDelayMs(back, 2_000)).toBeNull();
    });

    it("fails at the deadline when the server really does not come back", () => {
      const lost = disconnectServerRestart(installing, 1_000);
      expect(expireServerRestart(lost, 1_000 + SERVER_RESTART_TIMEOUT_MS - 1)).toBe(lost);
      expect(expireServerRestart(lost, 1_000 + SERVER_RESTART_TIMEOUT_MS)).toMatchObject({
        status: "failed",
        reason: "Server did not come back",
      });
    });

    it("leaves other states alone", () => {
      expect(serverRestartReconnected(installing)).toBe(installing);
      expect(serverRestartReconnected({ status: "idle" })).toEqual({ status: "idle" });
    });
  });
});
