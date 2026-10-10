import { describe, expect, it, vi } from "vite-plus/test";
import { RemoteEnvironmentClient } from "../src/client.js";
import type { SavedEnvironment } from "../src/types.js";
import { descriptorFixture } from "./descriptor-fixture.js";

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
const thread = {
  id: "22222222-2222-4222-8222-222222222222",
  parentThreadId: null,
  projectId: "project",
  title: "Worker",
  modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

function harness() {
  const request = vi.fn(async (method: string) => {
    if (method === "threadMetadataList") return [{ threadId: thread.id, parentThreadId: "parent" }];
    throw new Error(`unexpected ${method}`);
  });
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { threadNesting: true },
    }),
    rpcFactory: () => ({
      request,
      dispose: vi.fn(async () => undefined),
      subscribeShellSnapshot: vi.fn(),
      subscribeThreadSnapshot: vi.fn(async () => ({
        kind: "snapshot" as const,
        snapshot: { snapshotSequence: 1, thread },
      })),
    }),
  });
  const metadataReads = () =>
    request.mock.calls.filter(([method]) => method === "threadMetadataList").length;
  return { client, metadataReads };
}

describe("one-thread reads and the metadata table", () => {
  it("reads every thread's metadata only when the caller wants nesting", async () => {
    const h = harness();
    expect((await h.client.findThread(thread.id)).parentThreadId).toBe("parent");
    expect(h.metadataReads()).toBe(1);
    const light = await h.client.findThread(thread.id, { nesting: false });
    expect(h.metadataReads()).toBe(1);
    expect(light).toEqual(thread);
  });

  it("lists pending requests without the metadata read, with the same result", async () => {
    const h = harness();
    expect(await h.client.pending(thread.id)).toEqual([]);
    expect(h.metadataReads()).toBe(0);
  });
});
