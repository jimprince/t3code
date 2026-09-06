import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { APP_VERSION } from "./branding";
import {
  buildHeadlessUpdateCheckRequest,
  resolveHeadlessUpdateCheckOutcome,
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
  it("builds an explicit upgrade request when a linux server is older than the client", () => {
    expect(
      buildHeadlessUpdateCheckRequest(makeServerConfig({ os: "linux", serverVersion: "0.0.0" })),
    ).toEqual({
      clientVersion: APP_VERSION,
      serverVersion: "0.0.0",
    });
  });

  it("does not offer remote upgrades for non-linux or newer servers", () => {
    expect(
      buildHeadlessUpdateCheckRequest(makeServerConfig({ os: "darwin", serverVersion: "0.0.0" })),
    ).toBeNull();
    expect(
      buildHeadlessUpdateCheckRequest(makeServerConfig({ os: "linux", serverVersion: "999.0.0" })),
    ).toBeNull();
  });

  it("does not offer remote upgrades for legacy descriptors without platform data", () => {
    const serverConfig = makeServerConfig({ os: "linux", serverVersion: "0.0.0" });
    const legacyConfig = {
      environment: {
        ...serverConfig.environment,
        platform: undefined,
      },
    } as unknown as Pick<ServerConfig, "environment">;

    expect(buildHeadlessUpdateCheckRequest(legacyConfig)).toBeNull();
  });

  it.each([
    {
      status: "queued" as const,
      expected: {
        state: "requested",
        toastType: "success",
        title: "Remote upgrade requested",
      },
    },
    {
      status: "cooldown" as const,
      expected: {
        state: "requested",
        toastType: "info",
        title: "Remote upgrade already requested",
      },
    },
    {
      status: "unsupported" as const,
      expected: {
        state: "unavailable",
        toastType: "error",
        title: "Remote upgrade unavailable",
      },
    },
    {
      status: "error" as const,
      expected: {
        state: "failed",
        toastType: "error",
        title: "Could not start remote upgrade",
      },
    },
  ])("maps a $status response to banner state and feedback", ({ status, expected }) => {
    expect(
      resolveHeadlessUpdateCheckOutcome({
        status,
        checkedAt: new Date(0).toISOString(),
        message: `${status} detail`,
      }),
    ).toMatchObject({
      ...expected,
      description: `${status} detail`,
    });
  });
});
