import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig, ServerProvider } from "../src/vendor/t3contracts/server.js";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerConfig = Schema.decodeUnknownSync(ServerConfig);

describe("vendored server schemas", () => {
  it("defaults provider capability arrays when decoding legacy snapshots", () => {
    const parsed = decodeServerProvider({
      provider: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
  });

  it("decodes current provider-instance snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      displayName: "Codex Personal",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
        email: "user@example.com",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      availability: "available",
      models: [
        {
          slug: "gpt-5.7",
          name: "GPT 5.7",
          shortName: "5.7",
          subProvider: "OpenAI",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoningEffort",
                label: "Reasoning",
                type: "select",
                options: [{ id: "high", label: "High", isDefault: true }],
                currentValue: "high",
              },
            ],
          },
        },
      ],
    });

    expect(parsed.instanceId).toBe("codex_personal");
    expect(parsed.driver).toBe("codex");
    expect(parsed.models[0]?.slug).toBe("gpt-5.7");
  });

  it("decodes live server config features used for model discovery", () => {
    const parsed = decodeServerConfig({
      environment: {
        environmentId: "env-local",
        label: "local-mbp",
        platform: { os: "darwin", arch: "arm64" },
        serverVersion: "0.0.0-test",
        capabilities: { repositoryIdentity: true },
      },
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["bearer-access-token", "dpop-access-token"],
        sessionCookieName: "t3_session",
      },
      cwd: "/Users/brad/Programming/t3code",
      keybindingsConfigPath: "/Users/brad/.config/t3/keybindings.json",
      keybindings: [{ command: "modelPicker.toggle", key: "cmd+k" }],
      issues: [],
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated", email: "user@example.com" },
          checkedAt: "2026-04-10T00:00:00.000Z",
          availability: "available",
          models: [
            {
              slug: "gpt-5.7",
              name: "GPT 5.7",
              shortName: "5.7",
              isCustom: false,
              capabilities: { optionDescriptors: [] },
            },
          ],
        },
      ],
      availableEditors: ["cursor"],
      observability: {
        logsDirectoryPath: "/tmp/t3-logs",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      },
      settings: {},
    });

    expect(parsed.auth.sessionMethods).toContain("bearer-access-token");
    expect(parsed.auth.sessionMethods).toContain("dpop-access-token");
    expect(parsed.keybindings[0]).toEqual({ command: "modelPicker.toggle", key: "cmd+k" });
    expect(parsed.providers[0]?.models[0]?.capabilities).toEqual({ optionDescriptors: [] });
  });
});
