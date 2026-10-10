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
  startQueueDrainLoop,
  summarizeQueuedSends,
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
  it("holds explicit queued instructions until a settled recipient is explicitly unsettled", async () => {
    await withTempState(async () => {
      await queue("Please retry the operation");
      const thread = makeThread({ settledOverride: "settled" });
      const { clientFactory, sent } = createClientFactory({ thread: () => thread });
      await drainQueuedSends({ clientFactory });
      expect(sent).toEqual([]);
      expect((await loadState()).queuedSends[0]?.status).toBe("queued");
      thread.settledOverride = null;
      await drainQueuedSends({ clientFactory });
      expect(sent.map((message) => message.text)).toEqual(["Please retry the operation"]);
    });
  });

  it("re-reads a settled recipient once a minute, not on every pass, while its send is held", async () => {
    await withTempState(async () => {
      await queue("Please retry the operation");
      const thread = makeThread({ settledOverride: "settled" });
      let reads = 0;
      const { clientFactory: base, sent } = createClientFactory({ thread: () => thread });
      const clientFactory: QueueClientFactory = (environment) => ({
        ...base(environment),
        async findThread(threadId) {
          reads += 1;
          return base(environment).findThread(threadId);
        },
      });
      const settledTargets = new Map<string, number>();
      let time = Date.parse("2026-10-10T10:00:00.000Z");
      const drain = () =>
        drainQueuedSends({
          clientFactory,
          settledTargets,
          now: () => new Date(time).toISOString(),
        });

      await drain();
      time += 5_000;
      await drain();
      time += 5_000;
      await drain();
      expect(reads).toBe(1);
      expect((await loadState()).queuedSends[0]?.status).toBe("queued");

      // Unsettled meanwhile: seen on the next minute's read and delivered.
      thread.settledOverride = null;
      time += 60_000;
      await drain();
      expect(reads).toBe(2);
      expect(sent.map((message) => message.text)).toEqual(["Please retry the operation"]);
    });
  });

  it("holds legacy queued notifications after quota failure while permitting explicit operator retry", async () => {
    for (const text of [
      "HomeNetwork orchestrator notification: Worker needs attention",
      "Please retry now",
    ]) {
      await withTempState(async () => {
        await queue(text);
        const thread = makeThread({
          latestTurn: { ...makeThread().latestTurn!, state: "error" },
          activities: [
            {
              kind: "runtime.error",
              turnId: "turn-1",
              payload: {
                message:
                  "Claude usage limit reached. Send the message again once the limit resets.",
              },
            },
          ],
        });
        const { clientFactory, sent } = createClientFactory({ thread: () => thread });
        await drainQueuedSends({ clientFactory });
        const automatic = text.startsWith("HomeNetwork");
        expect(sent).toHaveLength(automatic ? 0 : 1);
        if (automatic) {
          expect((await loadState()).queuedSends[0]?.attempts).toBe(0);
          thread.latestTurn = {
            ...thread.latestTurn!,
            turnId: "retry-success",
            state: "completed",
          };
          await drainQueuedSends({ clientFactory });
          expect(sent).toHaveLength(1);
        }
      });
    }
  });

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

async function queueFrom(
  sender: string | null,
  text: string,
  coalesceKey?: string,
  threadId = "thread-worker-a",
) {
  return enqueueSend({
    threadId,
    agentName: "worker-a",
    environment: "dev-vm",
    text,
    queuedDuringTurnId: "turn-1",
    ...(sender ? { origin: { source: "thread-send" as const, fromThreadId: sender } } : {}),
    ...(coalesceKey ? { coalesceKey } : {}),
  });
}

describe("idle targets pick up their queue (#150)", () => {
  const interruptedThread = () =>
    makeThread({
      latestTurn: {
        turnId: "turn-2",
        state: "interrupted",
        requestedAt: "2026-09-05T00:00:03.000Z",
        startedAt: "2026-09-05T00:00:03.000Z",
        completedAt: "2026-09-05T00:00:04.000Z",
        assistantMessageId: null,
      },
      session: {
        threadId: "thread-worker-a",
        status: "interrupted",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-09-05T00:00:04.000Z",
      },
    });

  it("dispatches to a thread whose turn was interrupted", async () => {
    await withTempState(async () => {
      await queue("after the interrupt");
      const { clientFactory, sent } = createClientFactory({ thread: interruptedThread });

      await drainQueuedSends({ clientFactory, env: "dev-vm" });

      expect(sent.map((message) => message.text)).toEqual(["after the interrupt"]);
    });
  });

  it("dispatches to a thread whose session stopped, as after a server restart", async () => {
    await withTempState(async () => {
      await queue("after the restart");
      const { clientFactory, sent } = createClientFactory({
        thread: () =>
          makeThread({
            session: {
              threadId: "thread-worker-a",
              status: "stopped",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-09-05T00:00:04.000Z",
            },
          }),
      });

      await drainQueuedSends({ clientFactory, env: "dev-vm" });

      expect(sent.map((message) => message.text)).toEqual(["after the restart"]);
    });
  });

  it("keeps a send queued, without spending attempts, while the server is unreachable", async () => {
    // REGRESSION: a server restart outlasts five 5s passes, which used to mark the
    // whole queue undeliverable before the server was back.
    await withTempState(async () => {
      await queue("first");
      let reachable = false;
      const sent: string[] = [];
      const clientFactory: QueueClientFactory = () => ({
        async findThread() {
          if (!reachable) throw new Error("Failed to reach the server (fetch failed).");
          return makeThread();
        },
        async sendMessage(message) {
          sent.push(message.text);
          return { dispatched: true, queued: false };
        },
      });

      for (let pass = 0; pass < 8; pass += 1) {
        await drainQueuedSends({ clientFactory, env: "dev-vm", maxAttempts: 2 });
      }
      let state = await loadState();
      expect(state.queuedSends[0]).toMatchObject({ status: "queued", attempts: 0 });
      expect(state.queuedSends[0]?.lastError).toContain("fetch failed");

      reachable = true;
      await drainQueuedSends({ clientFactory, env: "dev-vm", maxAttempts: 2 });
      state = await loadState();
      expect(sent).toEqual(["first"]);
      expect(state.queuedSends[0]?.status).toBe("dispatched");
    });
  });

  it("does not let one hung or slow target hold up another thread's queue", async () => {
    await withTempState(async () => {
      await queue("stuck", "thread-hung");
      await queue("ready", "thread-idle");
      const sent: string[] = [];
      const clientFactory: QueueClientFactory = () => ({
        async findThread(threadId) {
          if (threadId === "thread-hung") return new Promise<never>(() => {});
          return makeThread({ id: threadId });
        },
        async sendMessage(message) {
          sent.push(message.text);
          return { dispatched: true, queued: false };
        },
      });

      await drainQueuedSends({ clientFactory, env: "dev-vm", readTimeoutMs: 20 });

      expect(sent).toEqual(["ready"]);
      const state = await loadState();
      expect(state.queuedSends.find((queued) => queued.text === "stuck")).toMatchObject({
        status: "queued",
        attempts: 0,
      });
    });
  });

  it("drains on its own cadence and stops cleanly", async () => {
    await withTempState(async () => {
      const { clientFactory, sent } = createClientFactory({});
      const loop = startQueueDrainLoop({ clientFactory, env: "dev-vm", intervalMs: 10 });
      try {
        await queue("while the loop runs");
        for (let waited = 0; sent.length === 0 && waited < 2_000; waited += 10) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(sent.map((message) => message.text)).toEqual(["while the loop runs"]);
      } finally {
        await loop.stop();
      }
    });
  });
});

describe("coalesced status notes", () => {
  it("replaces the same sender's waiting note with the same key and keeps everything else", async () => {
    await withTempState(async () => {
      await queueFrom("worker-1", "progress 1", "progress");
      await queueFrom("worker-2", "progress other worker", "progress");
      await queueFrom("worker-1", "decision needed");
      await queueFrom("worker-1", "other key", "phase");
      await queueFrom("worker-1", "other thread", "progress", "thread-worker-b");
      const latest = await queueFrom("worker-1", "progress 2", "progress");

      expect(latest.superseded.map(({ text }) => text)).toEqual(["progress 1"]);
      const open = listQueuedSends(await loadState(), { openOnly: true });
      expect(open.map(({ text }) => text)).toEqual([
        "progress other worker",
        "decision needed",
        "other key",
        "other thread",
        "progress 2",
      ]);
      const replaced = (await loadState()).queuedSends.find(({ text }) => text === "progress 1");
      expect(replaced).toMatchObject({
        status: "cancelled",
        lastError: `Superseded by ${latest.queued.id}.`,
      });
    });
  });

  it("never drops a send without a key, and never replaces one a watcher already claimed", async () => {
    await withTempState(async () => {
      await queueFrom("worker-1", "plain 1");
      const result = await queueFrom("worker-1", "plain 2");
      expect(result.superseded).toEqual([]);

      const claimed = await queueFrom("worker-1", "note 1", "progress");
      const state = await loadState();
      await saveState({
        ...state,
        queuedSends: state.queuedSends.map((send) =>
          send.id === claimed.queued.id ? { ...send, status: "dispatching" } : send,
        ),
      });
      const next = await queueFrom("worker-1", "note 2", "progress");

      expect(next.superseded).toEqual([]);
      expect(listQueuedSends(await loadState(), { openOnly: true })).toHaveLength(4);
    });
  });

  it("keeps an operator's keyed sends apart from workers' with the same key", async () => {
    await withTempState(async () => {
      await queueFrom(null, "operator note", "progress");
      const result = await queueFrom("worker-1", "worker note", "progress");
      expect(result.superseded).toEqual([]);
      const again = await queueFrom(null, "operator note 2", "progress");
      expect(again.superseded.map(({ text }) => text)).toEqual(["operator note"]);
    });
  });
});

describe("queue summary", () => {
  it("counts open sends by target and sender, largest first, ignoring settled ones", async () => {
    await withTempState(async () => {
      await queueFrom("worker-1", "a");
      await queueFrom("worker-1", "b");
      await queueFrom("worker-2", "c");
      await queueFrom("worker-2", "d", undefined, "thread-worker-b");
      const cancelled = await queueFrom("worker-1", "e");
      await cancelQueuedSend(cancelled.queued.id);

      const nowMs = Date.parse((await loadState()).queuedSends[0]!.queuedAt) + 90_000;
      expect(summarizeQueuedSends(await loadState(), {}, nowMs)).toEqual({
        open: 4,
        byTarget: [
          {
            threadId: "thread-worker-a",
            agentName: "worker-a",
            open: 3,
            bySender: [
              { sender: "worker-1", name: null, open: 2 },
              { sender: "worker-2", name: null, open: 1 },
            ],
            oldestAgeSeconds: 90,
          },
          {
            threadId: "thread-worker-b",
            agentName: "worker-a",
            open: 1,
            bySender: [{ sender: "worker-2", name: null, open: 1 }],
            oldestAgeSeconds: expect.any(Number),
          },
        ],
      });
      expect(summarizeQueuedSends(await loadState(), { threadId: "thread-worker-b" }).open).toBe(1);
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

it("preserves queued send provenance through durable state and delivery", async () => {
  await withTempState(async () => {
    const origin = { source: "thread-send" as const, fromThreadId: "child" };
    await enqueueSend({
      threadId: "thread-worker-a",
      agentName: null,
      environment: "dev-vm",
      text: "Please continue",
      queuedDuringTurnId: "turn-1",
      origin,
    });
    expect((await loadState()).queuedSends[0]?.origin).toEqual(origin);
    const delivered: unknown[] = [];
    const clientFactory: QueueClientFactory = () => ({
      async findThread() {
        return makeThread();
      },
      async sendMessage(message) {
        delivered.push(message.origin);
        return { dispatched: true, queued: false };
      },
    });
    await drainQueuedSends({ clientFactory });
    expect(delivered).toEqual([origin]);
    expect((await loadState()).queuedSends[0]?.status).toBe("dispatched");
  });
});

it("serializes concurrent keyed writers and keeps equal sender ids from different environments separate", async () => {
  await withTempState(async () => {
    const input = {
      threadId: "thread-worker-a",
      agentName: "worker-a",
      environment: "dev-vm",
      queuedDuringTurnId: "turn",
      coalesceKey: "status",
    };
    await Promise.all(
      ["one", "two", "three"].map((text) =>
        enqueueSend({
          ...input,
          text,
          origin: { source: "thread-send", fromThreadId: "sender", senderEnvironment: "source-a" },
        }),
      ),
    );
    await enqueueSend({
      ...input,
      text: "foreign",
      origin: { source: "thread-send", fromThreadId: "sender", senderEnvironment: "source-b" },
    });
    const state = await loadState();
    expect(state.queuedSends.filter((record) => record.status === "cancelled")).toHaveLength(2);
    const summary = summarizeQueuedSends(state);
    expect(summary.open).toBe(2);
    expect(summary.byTarget[0]?.bySender.map((sender) => sender.environment).sort()).toEqual([
      "source-a",
      "source-b",
    ]);
  });
});

describe("reliable handoff queue recovery", () => {
  it("delivers legacy queued work to a running turn once and stops on a dropped ack", async () => {
    await withTempState(async () => {
      await queue("fixture");
      let sends = 0;
      const clientFactory: QueueClientFactory = () => ({
        findThread: async () => runningThread(),
        supportsReliableHandoffs: async () => true,
        sendMessage: async (input) => {
          sends++;
          expect(input.commandId).toMatch(/^fork:queued-send:/);
          return {
            dispatched: false,
            queued: false,
            uncertain: true,
            causeCode: "TRANSPORT_TIMEOUT",
            sendId: input.commandId,
          };
        },
      });
      await drainQueuedSends({ clientFactory });
      expect((await loadState()).queuedSends[0]?.status).toBe("uncertain");
      await drainQueuedSends({ clientFactory });
      expect(sends).toBe(1);
    });
  });
  it("looks up an abandoned queued claim without resending it", async () => {
    await withTempState(async () => {
      await queue("fixture");
      const state = await loadState();
      state.queuedSends[0] = {
        ...state.queuedSends[0]!,
        status: "dispatching",
        lastAttemptedAt: "2020-01-01T00:00:00Z",
      };
      await saveState(state);
      let sends = 0,
        lookups = 0;
      const clientFactory: QueueClientFactory = () => ({
        findThread: async () => makeThread(),
        supportsReliableHandoffs: async () => true,
        lookupSendReceipt: async () => {
          lookups++;
          return { state: "unknown", receipts: [], retentionDays: 30 };
        },
        sendMessage: async () => {
          sends++;
          return { dispatched: true, queued: false };
        },
      });
      await drainQueuedSends({ clientFactory });
      expect((await loadState()).queuedSends[0]?.status).toBe("uncertain");
      expect(sends).toBe(0);
      expect(lookups).toBe(1);
    });
  });
});
