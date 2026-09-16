import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  refreshSavedEnvironmentSession,
  SESSION_REFRESH_WINDOW_MS,
  shouldRefreshEnvironmentSession,
} from "../src/sessionRefresh.js";
import { loadState, saveState } from "../src/state.js";
import type { SavedEnvironment, StateFile } from "../src/types.js";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
let tempDir = "";

function environment(daysRemaining: number): SavedEnvironment {
  return {
    name: "local-mbp",
    httpBaseUrl: "http://127.0.0.1:3773",
    wsBaseUrl: "ws://127.0.0.1:3773",
    environmentId: "environment-local",
    label: "Local Mac",
    serverVersion: "0.0.41",
    bearerToken: "old-token",
    expiresAt: new Date(NOW + daysRemaining * 24 * 60 * 60 * 1000).toISOString(),
    pairedAt: "2026-08-16T12:00:00.000Z",
  };
}

function state(saved: SavedEnvironment): StateFile {
  return {
    version: 1,
    environments: [saved],
    agents: [],
    subscriptions: [],
    notifications: [],
    queuedSends: [],
  };
}

beforeEach(async () => {
  tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-session-refresh-"));
  process.env.T3_AGENT_STATE_FILE = NodePath.join(tempDir, "state.json");
});

afterEach(async () => {
  delete process.env.T3_AGENT_STATE_FILE;
  await NodeFSP.rm(tempDir, { recursive: true, force: true });
});

describe("saved environment session refresh", () => {
  it("refreshes at six days remaining and persists the replacement atomically", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    let calls = 0;

    const refreshed = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      refresh: async () => {
        calls += 1;
        return {
          access_token: "new-token",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          token_type: "Bearer",
          expires_in: 30 * 24 * 60 * 60,
          scope: "orchestration:read",
        };
      },
    });

    expect(calls).toBe(1);
    expect(refreshed.bearerToken).toBe("new-token");
    expect((await loadState()).environments[0]?.bearerToken).toBe("new-token");
  });

  it("does not refresh at eight days remaining", async () => {
    const saved = environment(8);
    await saveState(state(saved));
    let calls = 0;

    const result = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      refresh: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual(saved);
    expect(shouldRefreshEnvironmentSession(environment(6), NOW)).toBe(true);
    expect(shouldRefreshEnvironmentSession(environment(8), NOW)).toBe(false);
    expect(SESSION_REFRESH_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("warns once and continues with the existing token when an older server returns 404", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    const warnings: string[] = [];

    const result = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      refresh: async () => {
        throw new Error("Remote request failed (404).");
      },
      warn: (message) => warnings.push(message),
    });

    expect(result.bearerToken).toBe("old-token");
    expect((await loadState()).environments[0]?.bearerToken).toBe("old-token");
    expect(warnings).toEqual([
      "Warning: could not refresh session for environment 'local-mbp': Remote request failed (404). Continuing with the existing token.",
    ]);
  });

  it("never refreshes an expired token", async () => {
    const saved = environment(-1);
    await saveState(state(saved));
    let calls = 0;
    await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      refresh: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    });
    expect(calls).toBe(0);
  });
});
