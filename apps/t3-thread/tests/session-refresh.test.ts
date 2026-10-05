import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
  vi.unstubAllGlobals();
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
      discover: async () => true,
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
      discover: async () => true,
      refresh: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    });

    expect(calls).toBe(0);
    expect(result).toEqual(saved);
    expect(shouldRefreshEnvironmentSession(environment(6), NOW)).toBe(true);
    expect(shouldRefreshEnvironmentSession(environment(8), NOW)).toBe(false);
    expect(shouldRefreshEnvironmentSession(environment(7), NOW)).toBe(true);
    expect(shouldRefreshEnvironmentSession(environment(0), NOW)).toBe(false);
    expect(shouldRefreshEnvironmentSession({ ...environment(6), expiresAt: "invalid" }, NOW)).toBe(
      false,
    );
    expect(SESSION_REFRESH_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("warns once and continues with the existing token when an older server returns 404", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    const warnings: string[] = [];

    const result = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      discover: async () => true,
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
      discover: async () => true,
      refresh: async () => {
        calls += 1;
        throw new Error("should not run");
      },
    });
    expect(calls).toBe(0);
  });
  it("skips refresh when the V2 descriptor does not advertise support", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    const result = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      discover: async () => false,
      refresh: async () => {
        throw new Error("must not run");
      },
    });
    expect(result).toEqual(saved);
  });

  it("preserves the winning credential across concurrent refreshes and retries", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    let sequence = 0;
    const refresh = async () => ({
      access_token: `new-token-${++sequence}`,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer" as const,
      expires_in: 30 * 86400,
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        refreshSavedEnvironmentSession(saved, { nowMs: NOW, discover: async () => true, refresh }),
      ),
    );
    expect(results[0]?.bearerToken).toBe(results[1]?.bearerToken);
    expect((await loadState()).environments[0]?.bearerToken).toBe(results[0]?.bearerToken);
    const retry = await refreshSavedEnvironmentSession(saved, {
      nowMs: NOW,
      discover: async () => {
        throw new Error("must not run");
      },
    });
    expect(retry.bearerToken).toBe(results[0]?.bearerToken);
  });

  it("discovers protocol 2 refresh support before rotating using the HTTP endpoint", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      calls.push(new URL(url).pathname);
      if (url.includes("/.well-known/"))
        return Response.json({
          orchestrationProtocolVersion: 2,
          capabilities: { sessionRefresh: true },
        });
      expect(init?.headers).toMatchObject({ authorization: "Bearer old-token" });
      return Response.json({
        access_token: "http-token",
        token_type: "Bearer",
        expires_in: 30 * 86400,
      });
    });
    const result = await refreshSavedEnvironmentSession(saved, { nowMs: NOW });
    expect(result.bearerToken).toBe("http-token");
    expect(calls).toEqual(["/.well-known/t3/environment", "/api/auth/session/refresh"]);
  });

  it("leaves persisted credentials intact when an old descriptor lacks the V2 capability", async () => {
    const saved = environment(6);
    await saveState(state(saved));
    const fetch = vi.fn(async () => Response.json({ capabilities: {} }));
    vi.stubGlobal("fetch", fetch);
    const result = await refreshSavedEnvironmentSession(saved, { nowMs: NOW });
    expect(result).toEqual(saved);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await loadState()).environments[0]).toEqual(saved);
  });
});
