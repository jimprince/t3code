import { describe, expect, it, vi } from "vite-plus/test";
import { descriptorFixture } from "./descriptor-fixture.js";
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
      const request = vi.fn(async (method: string, _payload?: unknown) => {
        if (method === "serverGetConfig") return config;
        return { sequence: 1 };
      });
      const client = new RemoteEnvironmentClient(environment, {
        descriptorFactory: async () => ({
          ...(await descriptorFixture(environment)()),
          capabilities: { threadNesting: true },
        }),
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
        "threadMetadataUpdate",
        expect.objectContaining({ settleOnComplete: expected }),
      );
      for (const [method, payload] of request.mock.calls) {
        if (method === "launchThread") expect(payload).not.toHaveProperty("settleOnComplete");
      }
    },
  );
});

it("resolves a source caller's inherited purpose and respects an explicit unnest", async () => {
  let rows = [
    { threadId: "owner", parentThreadId: null, purpose: "harness" as "harness" | "project" | null },
  ];
  const client = new RemoteEnvironmentClient(environment, {
    rpcFactory: () => ({
      request: vi.fn(async () => rows),
      dispose: vi.fn(async () => undefined),
      subscribeShellSnapshot: vi.fn(async () => ({
        kind: "snapshot" as const,
        snapshot: {
          projects: [],
          snapshotSequence: 0,
          threads: [
            {
              id: "native-caller",
              lineage: {
                parentThreadId: "owner",
                rootThreadId: "owner",
                relationshipToParent: "subagent",
              },
            },
          ],
        },
      })),
      subscribeThreadSnapshot: vi.fn(),
    }),
  });
  expect(await client.effectiveThreadPurpose("native-caller")).toBe("harness");
  rows = [...rows, { threadId: "native-caller", parentThreadId: null, purpose: null }];
  expect(await client.effectiveThreadPurpose("native-caller")).toBe("project");
  expect(await client.effectiveThreadPurpose("unknown-caller")).toBeNull();
});
