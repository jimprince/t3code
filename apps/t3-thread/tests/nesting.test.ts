import { sameThreadOrderGroup } from "../src/threadOrder.js";
import { selectRemoteThreadChildren } from "../src/status.js";
import type { OrchestrationThreadShell } from "../src/types.js";
import { describe, expect, it, vi } from "vite-plus/test";
import { Schema } from "effect";
import { RemoteEnvironmentClient } from "../src/client.js";
import { ThreadMetadataUpdate } from "../src/v2/nesting.js";
import { descriptorFixture } from "./descriptor-fixture.js";
import type { SavedEnvironment } from "../src/types.js";
const environment: SavedEnvironment = {
  name: "test",
  environmentId: "env",
  label: "Test",
  httpBaseUrl: "http://test",
  wsBaseUrl: "ws://test",
  bearerToken: "test",
  serverVersion: "test",
  pairedAt: "2026-10-05",
  expiresAt: "2099-01-01",
};
const child = {
  id: "child",
  parentThreadId: null,
  executionParentThreadId: "execution-parent",
  projectId: "other-project",
  pinOrderKey: "saved-pin",
  activeOrderKey: "saved-active",
  title: "Worker",
};
function harness(supported = true, remoteSupported = true) {
  let metadata: {
    threadId: string;
    parentThreadId: string | null;
    remoteParent?: { environmentId: string; threadId: string } | null;
    scope?: string | null;
  }[] = [{ threadId: "child", parentThreadId: "parent", scope: "saved-scope" }];
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "threadMetadataList") return metadata;
    if (method === "threadMetadataUpdate") {
      const update = Schema.decodeUnknownSync(ThreadMetadataUpdate)(input);
      const value = {
        ...metadata.find((row) => row.threadId === update.threadId),
        threadId: update.threadId,
        parentThreadId: update.parentThreadId ?? null,
        remoteParent: update.remoteParent ?? null,
      };
      metadata = [...metadata.filter((row) => row.threadId !== update.threadId), value];
      return value;
    }
    if (method === "threadOrderReset") return;
    if (method === "launchThread") return { sequence: 1 };
    throw new Error(`Unexpected ${method}`);
  });
  const dispose = vi.fn(async () => {});
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: {
        threadNesting: supported,
        remoteThreadNesting: remoteSupported,
        threadOrderReset: supported,
      },
    }),
    rpcFactory: () => ({
      request,
      dispose,
      subscribeShellSnapshot: async () => ({
        kind: "snapshot",
        snapshot: {
          projects: [{ id: "project", workspaceRoot: "/tmp/project", title: "Project" }],
          threads: [child],
        },
      }),
      subscribeThreadSnapshot: async () => ({ kind: "snapshot", snapshot: { thread: child } }),
    }),
  });
  return { client, request, dispose };
}
describe("V2 organizational nesting", () => {
  it("claims an empty shell, commits parent and policy, then starts the first turn once", async () => {
    const { client, request } = harness();
    const created = await client.createAgentThread({ projectId: "project", title: "Worker", initialMessage: "Work", parentThreadId: "parent" });
    const launches = request.mock.calls.filter(([method]) => method === "launchThread");
    const updates = request.mock.calls.filter(([method]) => method === "threadMetadataUpdate");
    expect(launches).toHaveLength(2);
    expect(updates).toHaveLength(1);
    expect(launches[0]?.[1]).toMatchObject({ threadId: created.threadId });
    expect(launches[0]?.[1]).not.toHaveProperty("initialMessage");
    expect(updates[0]?.[1]).toMatchObject({ threadId: created.threadId, parentThreadId: "parent", remoteParent: null, settleOnComplete: true });
    expect(launches[1]?.[1]).toMatchObject({ threadId: created.threadId, initialMessage: { text: "Work" }, reuseExistingThread: true });
    expect(request.mock.calls.indexOf(launches[0]!)).toBeLessThan(request.mock.calls.indexOf(updates[0]!));
    expect(request.mock.calls.indexOf(updates[0]!)).toBeLessThan(request.mock.calls.indexOf(launches[1]!));
  });

  it("keeps ordering inside one environment-qualified remote-parent group", () => {
    const base = {
      id: "child",
      parentThreadId: null,
      pinnedAt: null,
      archivedAt: null,
      remoteParent: { environmentId: "remote", threadId: "parent" },
    } as OrchestrationThreadShell;
    expect(sameThreadOrderGroup(base, { ...base, id: "sibling" })).toBe(true);
    expect(
      sameThreadOrderGroup(base, {
        ...base,
        remoteParent: { environmentId: "other", threadId: "parent" },
      }),
    ).toBe(false);
    expect(sameThreadOrderGroup(base, { ...base, remoteParent: null })).toBe(false);
  });
  it("selects remote children and local descendants without mixing another environment's same UUID", () => {
    const shells = [
      {
        id: "remote-child",
        parentThreadId: null,
        remoteParent: { environmentId: "remote", threadId: "same-id" },
      },
      { id: "local-child", parentThreadId: "remote-child" },
      {
        id: "other-child",
        parentThreadId: null,
        remoteParent: { environmentId: "other", threadId: "same-id" },
      },
    ] as OrchestrationThreadShell[];
    expect(
      selectRemoteThreadChildren(
        shells,
        { environmentId: "remote", threadId: "same-id" },
        true,
      ).map((thread) => thread.id),
    ).toEqual(["remote-child", "local-child"]);
  });
  it("reads imported supervision across projects while preserving native lineage and order keys", async () => {
    const { client } = harness();
    expect((await client.listThreads())[0]).toMatchObject({
      parentThreadId: "parent",
      executionParentThreadId: "execution-parent",
      projectId: "other-project",
      pinOrderKey: "saved-pin",
      activeOrderKey: "saved-active",
      scope: "saved-scope",
    });
  });
  it("nests remotely, reads back, and unnests with an explicit null override", async () => {
    const { client, request } = harness();
    await client.setThreadParent("child", null, {
      environmentId: "remote-env",
      threadId: "remote-parent",
    });
    expect(await client.findThread("child")).toMatchObject({
      parentThreadId: null,
      remoteParent: { environmentId: "remote-env", threadId: "remote-parent" },
      scope: "saved-scope",
    });
    await client.setThreadParent("child", null);
    expect(await client.findThread("child")).toMatchObject({
      parentThreadId: null,
      remoteParent: null,
      executionParentThreadId: "execution-parent",
    });
    expect(request.mock.calls.every(([method]) => method !== "dispatchCommand")).toBe(true);
  });
  it("rejects unsupported nesting and reset before any mutation or launch", async () => {
    const { client, request } = harness(false);
    await expect(client.setThreadParent("child", "parent")).rejects.toThrow("capability");
    await expect(
      client.createAgentThread({
        projectId: "project",
        title: "Worker",
        initialMessage: "Work",
        parentThreadId: "parent",
      }),
    ).rejects.toThrow("No worker was created");
    await expect(client.resetThreadOrder("child")).rejects.toThrow("automatic-order reset");
    expect(request).not.toHaveBeenCalled();
  });
  it("rejects unsupported cross-environment creation before launch", async () => {
    const { client, request } = harness(true, false);
    await expect(
      client.createAgentThread({
        projectId: "project",
        title: "Worker",
        initialMessage: "Work",
        remoteParent: { environmentId: "other", threadId: "parent" },
      }),
    ).rejects.toThrow("No worker was created");
    expect(request).not.toHaveBeenCalled();
  });
  it("uses the fork reset service after its capability lands", async () => {
    const { client, request } = harness();
    await client.resetThreadOrder("child");
    expect(request).toHaveBeenCalledWith(
      "threadOrderReset",
      expect.objectContaining({ threadId: "child" }),
    );
  });
});

import { selectThreadChildren } from "../src/status.js";
const row = (
  id: string,
  parentThreadId: string | null,
  remoteParent?: { environmentId: string; threadId: string },
) => ({ id, parentThreadId, remoteParent }) as OrchestrationThreadShell;
it("remote child selection disambiguates colliding parent IDs and follows only local descendants", () => {
  const rows = [
    row("local-child", "parent"),
    row("remote-child", null, { environmentId: "remote", threadId: "parent" }),
    row("remote-grandchild", "remote-child"),
  ];
  expect(selectThreadChildren(rows, "parent", true, "remote").map((t) => t.id)).toEqual([
    "remote-child",
    "remote-grandchild",
  ]);
  expect(selectThreadChildren(rows, "parent", true).map((t) => t.id)).toEqual(["local-child"]);
});
it("cyclic legacy links terminate", () => {
  const rows = [row("a", "b"), row("b", "a")];
  expect(selectThreadChildren(rows, "a", true).map((t) => t.id)).toEqual(["b"]);
});
