import { descriptorFixture } from "./descriptor-fixture.js";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { OrchestrationV2Command } from "../../../packages/contracts/src/orchestrationV2.ts";
import { RemoteEnvironmentClient } from "../src/client.js";
import { encodeClientOrchestrationCommand } from "../src/contracts.js";
import { buildAgentOverview, formatOverviewLine } from "../src/monitor.js";
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
const base = {
  id: "22222222-2222-4222-8222-222222222222",
  parentThreadId: "parent",
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
  let current = { ...base, pinnedAt: null as string | null };
  const commands: (typeof OrchestrationV2Command.Type)[] = [];
  const resets: unknown[] = [];
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "forkOrderReset") {
      resets.push(input);
      return;
    }
    if (method === "forkMetadataList") return [{ threadId: base.id, parentThreadId: "parent" }];
    if (method === "serverGetConfig") return { providers: [], settings: DEFAULT_SERVER_SETTINGS };
    if (method === "launchThread") return { threadId: base.id };
    expect(method).toBe("dispatchCommand");
    const command = decode(encodeClientOrchestrationCommand(input));
    commands.push(command);
    if (command.type === "thread.pin" || command.type === "thread.unpin") {
      current = {
        ...current,
        id: command.threadId,
        pinnedAt: command.type === "thread.pin" ? timestamp : null,
      };
    }
    return { sequence: commands.length };
  });
  const dispose = vi.fn(async () => undefined);
  const rpcFactory = () => ({
    request,
    dispose,
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
    subscribeThreadSnapshot: vi.fn(async () => ({
      kind: "snapshot" as const,
      snapshot: { snapshotSequence: commands.length, thread: current },
    })),
  });
  return {
    client: new RemoteEnvironmentClient(environment, {
      descriptorFactory: descriptorFixture(environment),
      rpcFactory,
    }),
    commands,
    resets,
    thread: () => current,
  };
}

describe("worker pinning", () => {
  it("pins and unpins a nested worker using server commands and reads back the result", async () => {
    const h = harness();
    expect(await h.client.setThreadPinned(base.id, true)).toMatchObject({
      pinned: true,
      pinnedAt: timestamp,
    });
    expect(h.thread().parentThreadId).toBe("parent");
    expect(await h.client.setThreadPinned(base.id, false)).toMatchObject({
      pinned: false,
      pinnedAt: null,
    });
    expect(h.commands.map((command) => command.type)).toEqual(["thread.pin", "thread.unpin"]);
  });
  it.each([false, true])(
    "create pin=%s leaves default unpinned and optionally pins the new worker",
    async (pin) => {
      const h = harness();
      const created = await h.client.createAgentThread({
        projectId: "project",
        title: "Worker",
        initialMessage: "Do the work",
        ...(pin ? { pin: true } : {}),
      });
      expect(created.pinned).toBe(pin);
      expect(h.commands.map((command) => command.type)).toEqual(pin ? ["thread.pin"] : []);
    },
  );
  it("marks pinned workers in the all-worker status line", () => {
    const overview = buildAgentOverview(
      {
        name: "worker",
        environment: "test",
        threadId: base.id,
        projectId: "project",
        title: "Worker",
        createdAt: timestamp,
        lastSeenAssistantMessageId: null,
      },
      { ...base, pinnedAt: timestamp },
    );
    expect(overview.pinned).toBe(true);
    expect(formatOverviewLine(overview)).toContain("/pinned]");
  });

  it("dispatches persisted pinned/active order and reset commands", async () => {
    const h = harness();
    vi.spyOn(h.client, "describe").mockResolvedValue({
      environmentId: "test",
      label: "test",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: {
        threadPinReorder: true,
        threadActiveReorder: true,
        threadOrderReset: false,
      },
    });
    await h.client.applyThreadOrder([
      { threadId: base.id, section: "pinned", orderKey: "f" },
      { threadId: base.id, section: "active", orderKey: "m" },
    ]);
    await expect(h.client.resetThreadOrder(base.id)).rejects.toThrow("automatic-order reset");
    expect(h.commands).toEqual([
      expect.objectContaining({ type: "thread.pin.reorder", orderKey: "f" }),
      expect.objectContaining({ type: "thread.active.reorder", orderKey: "m" }),
    ]);
    vi.spyOn(h.client, "describe").mockResolvedValue({
      capabilities: { threadOrderReset: true },
    } as Awaited<ReturnType<typeof h.client.describe>>);
    await h.client.resetThreadOrder(base.id);
    expect(h.resets).toEqual([expect.objectContaining({ threadId: base.id })]);
  });

  it("puts a new pin before its direct siblings without moving a repeated pin", async () => {
    const h = harness();
    vi.spyOn(h.client, "listThreads").mockImplementation(async () => [
      {
        ...h.thread(),
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
      {
        ...h.thread(),
        id: "sibling",
        pinnedAt: timestamp,
        pinOrderKey: "f",
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
      {
        ...h.thread(),
        id: "unrelated",
        parentThreadId: "other",
        pinnedAt: timestamp,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      },
    ]);
    await h.client.setThreadPinned(base.id, true);
    const order = h.commands.filter((command) => command.type === "thread.pin.reorder");
    expect(order.map((command) => command.threadId)).toEqual([base.id, "sibling"]);
    await h.client.setThreadPinned(base.id, true);
    expect(h.commands.filter((command) => command.type === "thread.pin.reorder")).toHaveLength(2);
  });
});
