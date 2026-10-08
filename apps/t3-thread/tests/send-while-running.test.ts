import { descriptorFixture } from "./descriptor-fixture.js";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import { loadState } from "../src/state.js";
import type { OrchestrationThread, SavedEnvironment } from "../src/types.js";

const environment: SavedEnvironment = {
  name: "local-mbp",
  httpBaseUrl: "http://127.0.0.1:3773",
  wsBaseUrl: "ws://127.0.0.1:3773",
  environmentId: "env-local",
  label: "Local",
  serverVersion: "0.1.0",
  bearerToken: "token",
  expiresAt: "2099-01-01T00:00:00.000Z",
  pairedAt: "2026-07-11T00:00:00.000Z",
};

function makeRunningThread(): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Worker",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "t3/worker",
    worktreePath: "/tmp/worker",
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-09-04T00:00:00.000Z",
      startedAt: "2026-09-04T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
    archivedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: { status: "running", activeTurnId: "turn-1", lastError: null },
  } as unknown as OrchestrationThread;
}

function makeHarness(thread: OrchestrationThread) {
  const commands: Array<Record<string, unknown>> = [];
  const rpc = {
    request: vi.fn(async (method: string, input: any) => {
      expect(method).toBe("fork.send.accept");
      commands.push(input);
      const status = thread.archivedAt
        ? "refused"
        : thread.session?.status === "running"
          ? input.allowQueueFallback === false
            ? "refused"
            : "steered"
          : "started";
      return {
        sendId: input.sendId,
        recipientThreadId: thread.id,
        status,
        cause: thread.archivedAt ? "ARCHIVED" : status === "refused" ? "BUSY" : null,
        acceptedAt: "2026-10-07T00:00:00Z",
        ownerThreadId: null,
      };
    }),
    dispose: vi.fn(async () => undefined),
  };
  return {
    client: new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => ({
        ...(await descriptorFixture(environment)()),
        capabilities: { reliableHandoffs: true },
      }),
      rpcFactory: () => rpc as any,
    }),
    commands,
  };
}

async function withTempState(test: () => Promise<void>): Promise<void> {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-send-test-"));
  const previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(tempDir, "state.json");
  try {
    await test();
  } finally {
    if (previousStateFile === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = previousStateFile;
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

describe("server admission of CLI sends", () => {
  it("routes a running thread through native steering without a local queue", async () => {
    await withTempState(async () => {
      const harness = makeHarness(makeRunningThread());
      expect(
        await harness.client.sendMessage({ threadId: "thread-1", text: "status?" }),
      ).toMatchObject({ dispatched: true, receipt: { status: "steered" } });
      expect(harness.commands[0]).toMatchObject({ recipientThreadId: "thread-1", intent: "auto" });
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });
  it("passes a no-queue refusal policy to the locked server admission", async () => {
    await withTempState(async () => {
      const harness = makeHarness(makeRunningThread());
      expect(
        await harness.client.sendMessage({
          threadId: "thread-1",
          text: "status?",
          queueWhileRunning: false,
        }),
      ).toMatchObject({ dispatched: false, queued: false, uncertain: false, causeCode: "BUSY" });
      expect(harness.commands[0]).toMatchObject({ allowQueueFallback: false });
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });
  it("preserves healthy idle delivery and archive refusals", async () => {
    await withTempState(async () => {
      const idle = makeHarness({ ...makeRunningThread(), session: null });
      expect(
        await idle.client.sendMessage({ threadId: "thread-1", text: "status?" }),
      ).toMatchObject({ dispatched: true, queued: false });
      const archived = makeHarness({ ...makeRunningThread(), archivedAt: "2026-09-04T00:02:00Z" });
      expect(
        await archived.client.sendMessage({ threadId: "thread-1", text: "status?" }),
      ).toMatchObject({ uncertain: false, causeCode: "ARCHIVED" });
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });
});
