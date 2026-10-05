import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { ClientOrchestrationCommand } from "../../../packages/contracts/src/orchestration.js";
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
  let current = {
    ...base,
    pinnedAt: null as string | null,
    autoSettleDisabledAt: null as string | null,
  };
  const commands: (typeof ClientOrchestrationCommand.Type)[] = [];
  const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "serverGetConfig") return { providers: [], settings: DEFAULT_SERVER_SETTINGS };
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
    if (command.type === "thread.auto-settle.set") {
      current = {
        ...current,
        id: command.threadId,
        autoSettleDisabledAt: command.enabled ? null : timestamp,
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
    client: new RemoteEnvironmentClient(environment, { rpcFactory }),
    commands,
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
  it("turns automatic settlement off and on and reads back the server state", async () => {
    const h = harness();
    expect(await h.client.setThreadAutoSettle(base.id, false)).toMatchObject({
      autoSettle: false,
      autoSettleDisabledAt: timestamp,
    });
    expect(await h.client.setThreadAutoSettle(base.id, true)).toMatchObject({
      autoSettle: true,
      autoSettleDisabledAt: null,
    });
    expect(
      h.commands.map((command) => [command.type, "enabled" in command && command.enabled]),
    ).toEqual([
      ["thread.auto-settle.set", false],
      ["thread.auto-settle.set", true],
    ]);
  });
  it.each([false, true])(
    "create pin=%s leaves default unpinned and optionally pins the new worker",
    async (pin) => {
      const h = harness();
      const created = await h.client.createAgentThread({
        projectId: "project",
        title: "Worker",
        parentThreadId: "parent",
        initialMessage: "Do the work",
        ...(pin ? { pin: true } : {}),
      });
      expect(created.pinned).toBe(pin);
      expect(h.commands.map((command) => command.type)).toEqual(
        pin ? ["thread.turn.start", "thread.pin"] : ["thread.turn.start"],
      );
      expect(h.commands[0]).toMatchObject({
        bootstrap: { createThread: { parentThreadId: "parent" } },
      });
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
        threadOrderReset: true,
      },
    });
    await h.client.applyThreadOrder([
      { threadId: base.id, section: "pinned", orderKey: "f" },
      { threadId: base.id, section: "active", orderKey: "m" },
    ]);
    await h.client.resetThreadOrder(base.id);
    expect(h.commands).toEqual([
      expect.objectContaining({ type: "thread.pin.reorder", orderKey: "f" }),
      expect.objectContaining({ type: "thread.active.reorder", orderKey: "m" }),
      expect.objectContaining({ type: "thread.order.reset" }),
    ]);
  });
});
