import {
  applyServerRestartEvent,
  disconnectServerRestart,
  expireServerRestart,
  SERVER_RESTART_TIMEOUT_MS,
  type ServerRestartState,
} from "@t3tools/client-runtime/fork/server-restart";
import type { ServerLifecycleStreamEvent } from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  describeServerRestart,
  followServerRestartEvents,
  restartLifecycleEvents,
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

  describe("following the server's lifecycle subscription", () => {
    const target = "0.0.46-nightly.20261008.1-fork.6";
    const ready = (sequence: number, at: string, serverVersion: string) =>
      ({
        version: 1,
        sequence,
        type: "ready",
        payload: { at, environment: { serverVersion } },
      }) as unknown as ServerLifecycleStreamEvent;
    const welcome = { version: 1, sequence: 1, type: "welcome" } as ServerLifecycleStreamEvent;
    const migrated = {
      version: 1,
      sequence: 3,
      type: "legacyThreadMigration",
      payload: { status: "complete", totalThreadCount: 2 },
    } as ServerLifecycleStreamEvent;

    // Runs one subscription replay through the same atom shape the app uses.
    const replay = (
      start: ServerRestartState,
      events: ReadonlyArray<ServerLifecycleStreamEvent>,
    ) => {
      const registry = AtomRegistry.make();
      const atom = Atom.make(restartLifecycleEvents(Stream.fromIterable(events)));
      let state = start;
      const stop = followServerRestartEvents(registry, atom, (event) => {
        state = applyServerRestartEvent(state, event);
      });
      stop();
      registry.dispose();
      return state;
    };
    const lost = serverRestartReconnected(updating({ deadline: 91_000 }));

    it("opens the subscription and resolves on the restarted server's ready", () => {
      expect(replay(lost, [welcome, ready(2, "2026-10-08T20:01:00.000Z", target)])).toMatchObject({
        status: "updated",
        serverVersion: target,
      });
      expect(replay(lost, [welcome, ready(2, "2026-10-08T20:01:00.000Z", "0.0.45")])).toMatchObject(
        { status: "back", serverVersion: "0.0.45" },
      );
    });

    it("recovers from did not come back once the server returns", () => {
      const failed = expireServerRestart(
        disconnectServerRestart(updating(), 1_000),
        1_000 + SERVER_RESTART_TIMEOUT_MS,
      );
      expect(failed.status).toBe("failed");
      expect(replay(failed, [welcome, ready(2, "2026-10-08T20:03:00.000Z", target)]).status).toBe(
        "updated",
      );
    });

    it("still sees ready when a migration notice follows it in the replay", () => {
      expect(
        replay(lost, [welcome, ready(2, "2026-10-08T20:01:00.000Z", target), migrated]).status,
      ).toBe("updated");
    });

    it("keeps updating when the old server, still installing, replays its earlier ready", () => {
      const announcing = {
        version: 1,
        sequence: 3,
        type: "updating",
        payload: {
          at: "2026-10-08T20:00:00.000Z",
          targetVersion: target,
          phase: "restarting",
          etaSeconds: 20,
        },
      } as ServerLifecycleStreamEvent;
      expect(
        replay(lost, [welcome, ready(2, "2026-10-08T19:00:00.000Z", "0.0.45"), announcing]),
      ).toMatchObject({ status: "updating", phase: "restarting" });
    });
  });
});

it("offers reconnect Retry only for connection loss, while retaining update recovery guidance", () => {
  const base = {
    ...updating(),
    status: "failed" as const,
    reason: "rolled back",
    manualUpdateCommand: "t3 service update",
  };
  expect(describeServerRestart({ ...base, failureKind: "update" }, null)).toMatchObject({
    tone: "failed",
    canRetry: false,
    manualUpdateCommand: "t3 service update",
  });
  expect(serverRestartClearDelayMs({ ...base, failureKind: "update" })).toBeNull();
  expect(describeServerRestart({ ...base, failureKind: "reconnect" }, null)?.canRetry).toBe(true);
});
