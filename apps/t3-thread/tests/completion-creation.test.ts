import { describe, expect, it, vi } from "vite-plus/test";
import { RemoteEnvironmentClient } from "../src/client.js";
import { decodeServerConfig } from "../src/contracts.js";
import type { SavedEnvironment } from "../src/types.js";

const timestamp = "2026-10-01T00:00:00.000Z";
const environment: SavedEnvironment = {
  name: "test",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
  environmentId: "test",
  label: "test",
  serverVersion: "test",
  bearerToken: "test",
  expiresAt: timestamp,
  pairedAt: timestamp,
};

describe("worker completion creation", () => {
  it.each([
    { settings: undefined, explicit: undefined, expected: true },
    { settings: { subthreadSettleOnComplete: false }, explicit: undefined, expected: false },
    {
      settings: {
        subthreadSettleOnComplete: true,
        projectSettingsOverrides: { project: { subthreadSettleOnComplete: false } },
      },
      explicit: undefined,
      expected: false,
    },
    {
      settings: {
        subthreadSettleOnComplete: false,
        projectSettingsOverrides: { project: { subthreadSettleOnComplete: true } },
      },
      explicit: undefined,
      expected: true,
    },
    { settings: { subthreadSettleOnComplete: true }, explicit: false, expected: false },
    { settings: { subthreadSettleOnComplete: false }, explicit: true, expected: true },
  ])(
    "captures effective default $expected with explicit=$explicit",
    async ({ settings, explicit, expected }) => {
      const config = decodeServerConfig({ providers: [], ...(settings ? { settings } : {}) });
      const request = vi.fn(async (method: string) => {
        if (method === "serverGetConfig") return config;
        return { sequence: 1 };
      });
      const client = new RemoteEnvironmentClient(environment, {
        rpcFactory: () => ({
          request,
          dispose: vi.fn(async () => undefined),
          subscribeShellSnapshot: vi.fn(async () => ({
            kind: "snapshot" as const,
            snapshot: {
              snapshotSequence: 0,
              projects: [
                {
                  id: "project",
                  title: "Project",
                  workspaceRoot: "/tmp/project",
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: timestamp,
                  updatedAt: timestamp,
                },
              ],
              threads: [],
            },
          })),
          subscribeThreadSnapshot: vi.fn(),
        }),
      });
      await client.createAgentThread({
        projectId: "project",
        title: "Worker",
        initialMessage: "Do work",
        parentThreadId: "parent",
        settleOnComplete: explicit,
      });
      expect(request).toHaveBeenCalledWith(
        "dispatchCommand",
        expect.objectContaining({
          bootstrap: expect.objectContaining({
            createThread: expect.objectContaining({
              parentThreadId: "parent",
              settleOnComplete: expected,
            }),
          }),
        }),
      );
    },
  );
});
