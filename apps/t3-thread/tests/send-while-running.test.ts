import { drainQueuedSends } from "../src/sendQueue.js";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";

import { readMessageOrigin } from "@t3tools/shared/messageOrigin";

import { RemoteEnvironmentClient } from "../src/client.js";
import { loadState, saveState } from "../src/state.js";
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
    subscribeThreadSnapshot: vi.fn(async () => ({
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, thread },
    })),
    subscribeShellSnapshot: vi.fn(async () => ({
      kind: "snapshot",
      snapshot: { projects: [], threads: [] },
    })),
    request: vi.fn(async (_method: string, input: unknown) => {
      commands.push(input as Record<string, unknown>);
      return { sequence: commands.length };
    }),
    dispose: vi.fn(async () => undefined),
  };
  return {
    client: new RemoteEnvironmentClient(environment, { rpcFactory: () => rpc }),
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

describe("RemoteEnvironmentClient.sendMessage while a turn is running", () => {
  it("delivers a queued sender header once, retaining the origin record", async () => {
    await withTempState(async () => {
      await saveState({ ...(await loadState()), environments: [environment] });
      const thread = makeRunningThread();
      const harness = makeHarness(thread);
      const origin = {
        source: "thread-send" as const,
        fromThreadId: "parent-id",
        fromName: "parent",
      };
      await harness.client.sendMessage({
        threadId: thread.id,
        text: "continue",
        origin,
        senderEnvironment: "dev-vm",
      });
      const queued = (await loadState()).queuedSends[0]!;
      expect(queued.text).toContain('thread_id: "parent-id"');
      expect(queued.text).toContain('saved_name: "parent"');
      expect(queued.text).toContain('environment: "dev-vm"');
      expect(queued.text).toContain('reply: "t3-thread send parent ..."');
      thread.latestTurn = { ...thread.latestTurn!, state: "completed" };
      thread.session = null;
      thread.settledOverride = "settled";
      expect(await drainQueuedSends({ clientFactory: () => harness.client })).toHaveLength(1);
      const message = harness.commands[0]!.message as { text: string; context: unknown };
      expect(message.text).toBe(queued.text);
      expect(message.text.match(/T3 thread message:/g)).toHaveLength(1);
      expect(readMessageOrigin(message)).toEqual(origin);
    });
  });
  it("queues the message and dispatches it at the next turn boundary", async () => {
    await withTempState(async () => {
      const harness = makeHarness(makeRunningThread());

      const result = await harness.client.sendMessage({ threadId: "thread-1", text: "status?" });

      expect(result).toMatchObject({ queued: true, dispatched: false });
      expect(harness.commands).toHaveLength(0);

      // Accepted durably before `send` returns, so the CLI can exit immediately.
      const state = await loadState();
      expect(state.queuedSends).toHaveLength(1);
      expect(state.queuedSends[0]).toMatchObject({
        threadId: "thread-1",
        environment: "local-mbp",
        text: "status?",
        status: "queued",
        queuedDuringTurnId: "turn-1",
      });
    });
  });

  it("rejects instead of queueing when the caller opts out", async () => {
    // `--no-queue` keeps the historical contract available for callers that need a
    // mid-turn send to fail loudly rather than be held.
    await withTempState(async () => {
      const harness = makeHarness(makeRunningThread());

      await expect(
        harness.client.sendMessage({
          threadId: "thread-1",
          text: "status?",
          queueWhileRunning: false,
        }),
      ).rejects.toThrow(/is still running/);
      expect(harness.commands).toHaveLength(0);
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });

  it("dispatches immediately when the thread is idle", async () => {
    await withTempState(async () => {
      const idle = makeRunningThread();
      const harness = makeHarness({
        ...idle,
        latestTurn: {
          ...idle.latestTurn!,
          state: "completed",
          completedAt: "2026-09-04T00:01:00.000Z",
        },
        session: null,
      });

      const result = await harness.client.sendMessage({ threadId: "thread-1", text: "status?" });

      expect(result).toMatchObject({ dispatched: true, queued: false });
      expect(harness.commands).toHaveLength(1);
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });

  it("records who sent the message on both the dispatched and the queued path", async () => {
    await withTempState(async () => {
      const origin = { source: "thread-send" as const, fromThreadId: "thread-worker" };
      const idle = makeRunningThread();
      const idleHarness = makeHarness({ ...idle, latestTurn: null, session: null });
      await idleHarness.client.sendMessage({ threadId: "thread-1", text: "done", origin });
      const message = (idleHarness.commands[0] as { message: { context?: unknown } }).message;
      expect(readMessageOrigin({ text: "done", context: message.context as never })).toEqual(
        origin,
      );

      await makeHarness(makeRunningThread()).client.sendMessage({
        threadId: "thread-1",
        text: "done",
        origin,
      });
      expect((await loadState()).queuedSends[0]?.origin).toEqual(origin);
    });
  });

  it("refuses to send to an archived thread instead of queueing forever", async () => {
    await withTempState(async () => {
      const harness = makeHarness({
        ...makeRunningThread(),
        archivedAt: "2026-09-04T00:02:00.000Z",
      });

      await expect(
        harness.client.sendMessage({ threadId: "thread-1", text: "status?" }),
      ).rejects.toThrow(/archived/);
      expect((await loadState()).queuedSends).toHaveLength(0);
    });
  });
});
