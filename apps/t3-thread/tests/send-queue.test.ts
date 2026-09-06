import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  cancelQueuedSend,
  drainQueuedSends,
  enqueueSend,
  hasQueuedWork,
  listQueuedSends,
  type QueueClientFactory,
} from "../src/sendQueue.js";
import { loadState, saveState } from "../src/state.js";
import type { OrchestrationThread, SavedEnvironment, StateFile } from "../src/types.js";

function makeEnvironment(): SavedEnvironment {
  return {
    name: "dev-vm",
    httpBaseUrl: "http://example.test",
    wsBaseUrl: "ws://example.test",
    environmentId: "env-1",
    label: "Dev VM",
    serverVersion: "0.0.39",
    bearerToken: "token",
    expiresAt: "2099-01-01T00:00:00.000Z",
    pairedAt: "2026-09-01T00:00:00.000Z",
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-worker-a",
    projectId: "project-1",
    title: "Worker A",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-09-05T00:00:00.000Z",
      startedAt: "2026-09-05T00:00:01.000Z",
      completedAt: "2026-09-05T00:00:02.000Z",
      assistantMessageId: "assistant-1",
    },
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:02.000Z",
    archivedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function runningThread(): OrchestrationThread {
  return makeThread({
    latestTurn: {
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-09-05T00:00:03.000Z",
      startedAt: "2026-09-05T00:00:03.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
  });
}

function emptyState(): StateFile {
  return {
    version: 1,
    environments: [makeEnvironment()],
    agents: [],
    subscriptions: [],
    notifications: [],
    queuedSends: [],
  };
}

function createClientFactory(input: {
  thread?: () => OrchestrationThread;
  onSend?: (message: { threadId: string; text: string }) => Promise<void> | void;
}): { clientFactory: QueueClientFactory; sent: Array<{ threadId: string; text: string }> } {
  const sent: Array<{ threadId: string; text: string }> = [];
  const clientFactory: QueueClientFactory = () => ({
    async findThread() {
      return input.thread ? input.thread() : makeThread();
    },
    async sendMessage(message) {
      await input.onSend?.(message);
      sent.push({ threadId: message.threadId, text: message.text });
      return { dispatched: true, queued: false };
    },
  });
  return { clientFactory, sent };
}

async function withTempState(test: () => Promise<void>): Promise<void> {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-queue-test-"));
  const previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(tempDir, "state.json");
  try {
    await saveState(emptyState());
    await test();
  } finally {
    if (previousStateFile === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = previousStateFile;
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

async function queue(text: string, threadId = "thread-worker-a"): Promise<void> {
  await enqueueSend({
    threadId,
    agentName: "worker-a",
    environment: "dev-vm",
    text,
    queuedDuringTurnId: "turn-1",
  });
}

describe("send queue drain", () => {
  it("holds a queued send while the thread is still running", async () => {
    await withTempState(async () => {
      await queue("first");
      const { clientFactory, sent } = createClientFactory({ thread: runningThread });

      const settled = await drainQueuedSends({ clientFactory, env: "dev-vm" });

      expect(settled).toEqual([]);
      expect(sent).toEqual([]);
      const state = await loadState();
      expect(state.queuedSends[0]?.status).toBe("queued");
      // A boundary that has not arrived is not a failed attempt.
      expect(state.queuedSends[0]?.attempts).toBe(0);
    });
  });

  it("dispatches one message per turn boundary in arrival order", async () => {
    // REGRESSION: two sends held during one turn must not be coalesced into a
    // single prompt and must not both start turns at the same boundary.
    await withTempState(async () => {
      await queue("first");
      await queue("second");
      const { clientFactory, sent } = createClientFactory({});

      await drainQueuedSends({ clientFactory, env: "dev-vm" });
      let state = await loadState();
      expect(sent.map((message) => message.text)).toEqual(["first"]);
      expect(listQueuedSends(state, { openOnly: true })).toHaveLength(1);

      await drainQueuedSends({ clientFactory, env: "dev-vm" });
      state = await loadState();
      expect(sent.map((message) => message.text)).toEqual(["first", "second"]);
      expect(listQueuedSends(state, { openOnly: true })).toHaveLength(0);
      expect(state.queuedSends.every((queued) => queued.status === "dispatched")).toBe(true);
    });
  });

  it("dispatches a queued send only once across concurrent drain passes", async () => {
    await withTempState(async () => {
      await queue("first");
      const { clientFactory, sent } = createClientFactory({
        onSend: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });

      const [left, right] = await Promise.all([
        drainQueuedSends({ clientFactory, env: "dev-vm" }),
        drainQueuedSends({ clientFactory, env: "dev-vm" }),
      ]);

      expect(left.length + right.length).toBe(1);
      expect(sent).toHaveLength(1);
      expect((await loadState()).queuedSends[0]?.dispatchClaimId).toBeNull();
    });
  });

  it("does not overtake a claimed head when another watcher drains", async () => {
    await withTempState(async () => {
      await queue("first");
      await queue("second");
      let release!: () => void;
      let entered!: () => void;
      const sending = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { clientFactory, sent } = createClientFactory({
        onSend: async ({ text }) => {
          if (text === "first") {
            entered();
            await finish;
          }
        },
      });
      const firstPass = drainQueuedSends({ clientFactory });
      await sending;
      try {
        const secondPass = await drainQueuedSends({ clientFactory });
        expect(secondPass).toEqual([]);
        expect(sent).toEqual([]);
      } finally {
        release();
        await firstPass;
      }
      expect(sent.map((message) => message.text)).toEqual(["first"]);
    });
  });

  it("never delivers to an archived thread and drops the whole queue for it", async () => {
    await withTempState(async () => {
      await queue("first");
      await queue("second");
      const { clientFactory, sent } = createClientFactory({
        thread: () => makeThread({ archivedAt: "2026-09-05T00:01:00.000Z" }),
      });

      const settled = await drainQueuedSends({ clientFactory, env: "dev-vm" });

      expect(sent).toEqual([]);
      expect(settled).toHaveLength(2);
      const state = await loadState();
      expect(state.queuedSends.map((queued) => queued.status)).toEqual([
        "undeliverable",
        "undeliverable",
      ]);
      expect(state.queuedSends[0]?.lastError).toContain("archived");
    });
  });

  it("retries a failing dispatch and gives up at the attempt cap", async () => {
    await withTempState(async () => {
      await queue("first");
      const { clientFactory } = createClientFactory({
        onSend: () => {
          throw new Error("environment unreachable");
        },
      });

      await drainQueuedSends({ clientFactory, env: "dev-vm", maxAttempts: 2 });
      let state = await loadState();
      expect(state.queuedSends[0]).toMatchObject({ status: "queued", attempts: 1 });
      expect(state.queuedSends[0]?.lastError).toContain("environment unreachable");

      await drainQueuedSends({ clientFactory, env: "dev-vm", maxAttempts: 2 });
      state = await loadState();
      expect(state.queuedSends[0]).toMatchObject({ status: "undeliverable", attempts: 2 });
    });
  });

  it("cancels a queued send before it reaches the thread", async () => {
    await withTempState(async () => {
      await queue("first");
      const queued = (await loadState()).queuedSends[0]!;

      await cancelQueuedSend(queued.id);

      const { clientFactory, sent } = createClientFactory({});
      await drainQueuedSends({ clientFactory, env: "dev-vm" });

      expect(sent).toEqual([]);
      expect((await loadState()).queuedSends[0]?.status).toBe("cancelled");
    });
  });
});

describe("hasQueuedWork (watcher idle-exit guard)", () => {
  it("keeps the watcher alive while a send is still queued and releases it afterwards", async () => {
    // REGRESSION: the watcher owns queue drain, so it must not idle-exit with an
    // undispatched send, and must not be pinned open by terminal records.
    await withTempState(async () => {
      expect(hasQueuedWork(await loadState())).toBe(false);

      await queue("first");
      expect(hasQueuedWork(await loadState())).toBe(true);

      const { clientFactory } = createClientFactory({});
      await drainQueuedSends({ clientFactory, env: "dev-vm" });
      expect(hasQueuedWork(await loadState())).toBe(false);
    });
  });
});
