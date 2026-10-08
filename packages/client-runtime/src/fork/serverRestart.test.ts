import { EnvironmentId, type ServerLifecycleStreamEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  applyServerRestartEvent,
  disconnectServerRestart,
  expireServerRestart,
  SERVER_RESTART_TIMEOUT_MS,
} from "./serverRestart.ts";

const update: ServerLifecycleStreamEvent = {
  version: 1,
  sequence: 2,
  type: "updating",
  payload: {
    at: "2026-10-08T19:00:00.000Z",
    targetVersion: "1.0.0-fork.6",
    phase: "restarting",
    etaSeconds: 30,
    manualUpdateCommand: "t3 service update",
  },
};
const ready = (version: string, at = "2026-10-08T19:00:30.000Z"): ServerLifecycleStreamEvent => ({
  version: 1,
  sequence: 1,
  type: "ready",
  payload: {
    at,
    environment: {
      environmentId: EnvironmentId.make("env"),
      label: "Server",
      platform: { os: "linux", arch: "x64" },
      serverVersion: version,
      capabilities: { repositoryIdentity: true },
    },
  },
});

describe("server restart announcements", () => {
  it("proves updated or back from the actual returned version", () => {
    const state = applyServerRestartEvent({ status: "idle" }, update);
    expect(applyServerRestartEvent(state, ready("1.0.0-fork.6")).status).toBe("updated");
    expect(applyServerRestartEvent(state, ready("1.0.0-fork.5")).status).toBe("back");
    expect(applyServerRestartEvent(state, ready("1.0.0-fork.5", "2026-10-08T18:00:00.000Z"))).toBe(
      state,
    );
  });
  it("starts the 90-second deadline only on disconnection and accepts a late ready", () => {
    const state = applyServerRestartEvent({ status: "idle" }, update);
    expect(expireServerRestart(state, 999_999)).toBe(state);
    const disconnected = disconnectServerRestart(state, 1000);
    expect(disconnectServerRestart(disconnected, 2000)).toBe(disconnected);
    expect(expireServerRestart(disconnected, 1000 + SERVER_RESTART_TIMEOUT_MS - 1)).toBe(
      disconnected,
    );
    const timedOut = expireServerRestart(disconnected, 1000 + SERVER_RESTART_TIMEOUT_MS);
    expect(timedOut).toMatchObject({
      status: "failed",
      reason: "Server did not come back",
      manualUpdateCommand: "t3 service update",
    });
    expect(applyServerRestartEvent(timedOut, ready("1.0.0-fork.6")).status).toBe("updated");
  });
  it("reports preparation failure without inventing a manual command", () => {
    const event: ServerLifecycleStreamEvent = {
      ...update,
      payload: {
        at: update.payload.at,
        targetVersion: update.payload.targetVersion,
        phase: "failed",
        etaSeconds: 0,
        reason: "disk full",
      },
    };
    expect(applyServerRestartEvent({ status: "idle" }, event)).toEqual({
      status: "failed",
      failureKind: "update",
      targetVersion: "1.0.0-fork.6",
      announcedAt: update.payload.at,
      reason: "disk full",
    });
  });
});

it.each(["rolled-back", "failed"] as const)(
  "keeps %s outcomes failed through further ready events",
  (status) => {
    const state = applyServerRestartEvent({ status: "idle" }, update);
    const returned = ready("1.0.0-fork.5");
    if (returned.type !== "ready") throw new Error("fixture");
    const returnedWithOutcome = {
      ...returned,
      payload: {
        ...returned.payload,
        updateOutcome: {
          id: "update-1",
          fromVersion: "1.0.0-fork.5",
          targetVersion: "1.0.0-fork.6",
          status,
          reason: "Startup failed; restore the previous build",
        },
      },
    };
    const failed = applyServerRestartEvent(state, returnedWithOutcome);
    expect(failed).toMatchObject({
      status: "failed",
      failureKind: "update",
      reason: "Startup failed; restore the previous build",
      manualUpdateCommand: "t3 service update",
    });
    expect(applyServerRestartEvent(failed, ready("1.0.0-fork.5", "2026-10-08T20:00:00.000Z"))).toBe(
      failed,
    );
  },
);
it("does not replay dismissed announcements but admits a genuinely later update", () => {
  expect(applyServerRestartEvent({ status: "idle" }, update, update.payload.at)).toEqual({
    status: "idle",
  });
  const later = { ...update, payload: { ...update.payload, at: "2026-10-09T19:00:00.000Z" } };
  expect(applyServerRestartEvent({ status: "idle" }, later, update.payload.at).status).toBe(
    "updating",
  );
});
