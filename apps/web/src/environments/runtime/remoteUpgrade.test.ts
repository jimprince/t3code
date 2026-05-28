import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import type { SavedEnvironmentRecord, SavedEnvironmentRuntimeState } from "./catalog";
import { resolveRemoteUpgradeEligibility } from "./remoteUpgrade";

const environmentId = EnvironmentId.make("environment-remote");

function record(overrides: Partial<SavedEnvironmentRecord> = {}): SavedEnvironmentRecord {
  return {
    environmentId,
    label: "Remote",
    httpBaseUrl: "https://remote.example.com/",
    wsBaseUrl: "wss://remote.example.com/",
    createdAt: "2026-05-01T00:00:00.000Z",
    lastConnectedAt: null,
    ...overrides,
  };
}

function runtime(input: {
  readonly serverVersion?: string;
  readonly os?: "linux" | "darwin" | "windows";
}): SavedEnvironmentRuntimeState {
  return {
    connectionState: "disconnected",
    authState: "authenticated",
    lastError: null,
    lastErrorAt: null,
    role: "owner",
    descriptor: null,
    serverConfig: {
      environment: {
        environmentId,
        label: "Remote",
        serverVersion: input.serverVersion ?? "1.0.0",
        platform: {
          os: input.os ?? "linux",
          arch: "x64",
        },
      },
    } as ServerConfig,
    connectedAt: null,
    disconnectedAt: "2026-05-01T00:00:00.000Z",
  };
}

describe("resolveRemoteUpgradeEligibility", () => {
  it("is hidden for local or primary environments", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: null,
        runtime: runtime({ serverVersion: "0.9.0" }),
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "notRemote" });
  });

  it("is hidden when no last-known server config exists", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record(),
        runtime: null,
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "noServerConfig" });
  });

  it("is hidden when the client is not newer than the server", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record({
          desktopSsh: { alias: "remote", hostname: "remote", username: null, port: null },
        }),
        runtime: runtime({ serverVersion: "1.0.0" }),
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "clientNotNewer" });

    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record({
          desktopSsh: { alias: "remote", hostname: "remote", username: null, port: null },
        }),
        runtime: runtime({ serverVersion: "1.1.0" }),
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "clientNotNewer" });
  });

  it("is hidden for non-linux platforms", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record({
          desktopSsh: { alias: "remote", hostname: "remote", username: null, port: null },
        }),
        runtime: runtime({ serverVersion: "0.9.0", os: "darwin" }),
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "unsupportedPlatform" });
  });

  it("is hidden while connecting", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record({
          desktopSsh: { alias: "remote", hostname: "remote", username: null, port: null },
        }),
        runtime: runtime({ serverVersion: "0.9.0" }),
        connectionState: "connecting",
        clientVersion: "1.0.0",
      }),
    ).toEqual({ available: false, reason: "connecting" });
  });

  it("is available through desktop SSH for older linux remotes", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record({
          desktopSsh: { alias: "remote", hostname: "remote", username: null, port: null },
        }),
        runtime: runtime({ serverVersion: "0.9.0" }),
        connectionState: "disconnected",
        clientVersion: "1.0.0",
      }),
    ).toEqual({
      available: true,
      reason: "desktopSsh",
      serverVersion: "0.9.0",
      clientVersion: "1.0.0",
    });
  });

  it("is available through remote HTTP only when a bearer token exists", () => {
    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record(),
        runtime: runtime({ serverVersion: "0.9.0" }),
        connectionState: "error",
        clientVersion: "1.0.0",
        hasBearerToken: true,
      }),
    ).toEqual({
      available: true,
      reason: "remoteHttp",
      serverVersion: "0.9.0",
      clientVersion: "1.0.0",
    });

    expect(
      resolveRemoteUpgradeEligibility({
        environmentRecord: record(),
        runtime: runtime({ serverVersion: "0.9.0" }),
        connectionState: "error",
        clientVersion: "1.0.0",
        hasBearerToken: false,
      }),
    ).toEqual({ available: false, reason: "noOutOfBandPath" });
  });
});
