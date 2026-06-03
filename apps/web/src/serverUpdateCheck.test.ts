import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import type { WsRpcClient } from "@t3tools/client-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { APP_VERSION } from "./branding";
import {
  claimHeadlessUpdateCheckRequest,
  maybeRequestHeadlessUpdateCheck,
  resetHeadlessUpdateCheckRequestsForTests,
} from "./serverUpdateCheck";

const environmentId = EnvironmentId.make("environment-update-check");

function makeServerConfig(input: {
  readonly os: ServerConfig["environment"]["platform"]["os"];
  readonly serverVersion: string;
}): ServerConfig {
  return {
    environment: {
      environmentId,
      label: "Remote",
      platform: {
        os: input.os,
        arch: "x64",
      },
      serverVersion: input.serverVersion,
      capabilities: {
        repositoryIdentity: true,
      },
    },
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "t3.sid",
    },
    cwd: "/tmp/project",
    keybindingsConfigPath: "/tmp/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/tmp/logs",
      localTracingEnabled: true,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

describe("serverUpdateCheck", () => {
  beforeEach(() => {
    resetHeadlessUpdateCheckRequestsForTests();
  });

  it("claims one update check when a linux server is older than the client", () => {
    const serverConfig = makeServerConfig({ os: "linux", serverVersion: "0.0.0" });

    expect(claimHeadlessUpdateCheckRequest({ environmentId, serverConfig, nowMs: 1_000 })).toBe(
      true,
    );
    expect(claimHeadlessUpdateCheckRequest({ environmentId, serverConfig, nowMs: 1_001 })).toBe(
      false,
    );
  });

  it("does not claim update checks for non-linux or newer servers", () => {
    expect(
      claimHeadlessUpdateCheckRequest({
        environmentId,
        serverConfig: makeServerConfig({ os: "darwin", serverVersion: "0.0.0" }),
      }),
    ).toBe(false);
    expect(
      claimHeadlessUpdateCheckRequest({
        environmentId,
        serverConfig: makeServerConfig({ os: "linux", serverVersion: "999.0.0" }),
      }),
    ).toBe(false);
  });

  it("does not claim update checks for legacy descriptors without platform data", () => {
    const serverConfig = makeServerConfig({ os: "linux", serverVersion: "0.0.0" });
    const legacyConfig = {
      environment: {
        ...serverConfig.environment,
        platform: undefined,
      },
    } as unknown as Pick<ServerConfig, "environment">;

    expect(claimHeadlessUpdateCheckRequest({ environmentId, serverConfig: legacyConfig })).toBe(
      false,
    );
  });

  it("requests a server-side update check with client and server versions", () => {
    const requestHeadlessUpdateCheck = vi.fn().mockResolvedValue({
      status: "queued",
      checkedAt: new Date(0).toISOString(),
      message: null,
    });
    const client = {
      server: {
        requestHeadlessUpdateCheck,
      },
    } as unknown as WsRpcClient;

    maybeRequestHeadlessUpdateCheck({
      environmentId,
      serverConfig: makeServerConfig({ os: "linux", serverVersion: "0.0.0" }),
      client,
    });

    expect(requestHeadlessUpdateCheck).toHaveBeenCalledWith({
      clientVersion: APP_VERSION,
      serverVersion: "0.0.0",
    });
  });
});
