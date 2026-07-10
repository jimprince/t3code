import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { loadState, saveState } from "../src/state.js";
import type {
  OrchestrationThread,
  SavedAgent,
  SavedEnvironment,
  SavedSubscription,
  StateFile,
} from "../src/types.js";
import {
  deliverPendingNotifications,
  detectAttentionEvents,
  hasWatcherWork,
  type WatchClient,
  type WatchClientFactory,
} from "../src/watch.js";

function makeEnvironment(overrides: Partial<SavedEnvironment> = {}): SavedEnvironment {
  return {
    name: "dev-vm",
    httpBaseUrl: "http://example.test",
    wsBaseUrl: "ws://example.test",
    environmentId: "env-1",
    label: "Dev VM",
    serverVersion: "0.0.19",
    bearerToken: "token",
    expiresAt: "2026-04-18T00:00:00.000Z",
    pairedAt: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeAgent(overrides: Partial<SavedAgent> = {}): SavedAgent {
  return {
    name: "worker-a",
    environment: "dev-vm",
    threadId: "thread-worker-a",
    projectId: "project-1",
    title: "Worker A",
    createdAt: "2026-04-17T00:00:00.000Z",
    lastSeenAssistantMessageId: null,
    ...overrides,
  };
}

function makeSubscription(overrides: Partial<SavedSubscription> = {}): SavedSubscription {
  return {
    subscriberThreadId: "thread-coordinator-a",
    subscriberAgentName: "coordinator-a",
    subscriberEnvironment: "dev-vm",
    sourceThreadId: "thread-worker-a",
    sourceAgentName: "worker-a",
    sourceEnvironment: "dev-vm",
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-worker-a",
    projectId: "project-1",
    title: "Worker A",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-04-17T00:00:00.000Z",
      startedAt: "2026-04-17T00:00:01.000Z",
      completedAt: "2026-04-17T00:00:02.000Z",
      assistantMessageId: "assistant-1",
    },
    createdAt: "2026-04-17T00:00:00.000Z",
    updatedAt: "2026-04-17T00:00:02.000Z",
    archivedAt: null,
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        text: "Worker finished the task and needs coordinator review.",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-04-17T00:00:02.000Z",
        updatedAt: "2026-04-17T00:00:02.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeState(): StateFile {
  return {
    version: 1,
    environments: [makeEnvironment()],
    agents: [
      makeAgent(),
      makeAgent({
        name: "coordinator-a",
        threadId: "thread-coordinator-a",
        title: "Coordinator A",
      }),
    ],
    subscriptions: [makeSubscription()],
    notifications: [],
  };
}

function createClientFactory(input: {
  sourceThread?: OrchestrationThread;
  subscriberThread?: OrchestrationThread;
  onSend?: (message: { threadId: string; text: string }) => Promise<void> | void;
}): { clientFactory: WatchClientFactory; sentMessages: Array<{ threadId: string; text: string }> } {
  const sourceThread = input.sourceThread ?? makeThread();
  const subscriberThread =
    input.subscriberThread ??
    makeThread({
      id: "thread-coordinator-a",
      title: "Coordinator A",
      latestTurn: null,
      messages: [],
    });
  const sentMessages: Array<{ threadId: string; text: string }> = [];

  const clientFactory: WatchClientFactory = (_environment) => {
    const client: WatchClient = {
      async findThread(threadId) {
        if (threadId === sourceThread.id) {
          return sourceThread;
        }
        if (threadId === subscriberThread.id) {
          return subscriberThread;
        }
        throw new Error(`Unexpected thread lookup '${threadId}'.`);
      },
      async sendMessage(message) {
        await input.onSend?.(message);
        sentMessages.push(message);
      },
    };
    return client;
  };

  return {
    clientFactory,
    sentMessages,
  };
}

async function withTempState(test: () => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "t3-thread-watch-test-"));
  const stateFile = path.join(tempDir, "state.json");
  const previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = stateFile;

  try {
    await saveState(makeState());
    await test();
  } finally {
    if (previousStateFile === undefined) {
      delete process.env.T3_AGENT_STATE_FILE;
    } else {
      process.env.T3_AGENT_STATE_FILE = previousStateFile;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
}

describe("watch flows", () => {
  it("deduplicates repeated detection passes and leaves notifications pending in no-deliver mode", async () => {
    await withTempState(async () => {
      const { clientFactory, sentMessages } = createClientFactory({});

      const first = await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const second = await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const state = await loadState();

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]?.status).toBe("pending");
      expect(sentMessages).toEqual([]);
    });
  });

  it("claims and delivers a pending notification only once across concurrent delivery passes", async () => {
    await withTempState(async () => {
      const { clientFactory, sentMessages } = createClientFactory({
        onSend: async () => {
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
      });

      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const [first, second] = await Promise.all([
        deliverPendingNotifications({ env: "dev-vm", clientFactory }),
        deliverPendingNotifications({ env: "dev-vm", clientFactory }),
      ]);
      const state = await loadState();

      expect(first.length + second.length).toBe(1);
      expect(sentMessages).toHaveLength(1);
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]?.status).toBe("delivered");
      expect(state.notifications[0]?.deliveryClaimId).toBeNull();
    });
  });

  it("records delivery failures and retries them on a later pass", async () => {
    await withTempState(async () => {
      let failDelivery = true;
      const { clientFactory, sentMessages } = createClientFactory({
        onSend: async () => {
          if (failDelivery) {
            throw new Error("subscriber unreachable");
          }
        },
      });

      await detectAttentionEvents({ env: "dev-vm", clientFactory });

      const failed = await deliverPendingNotifications({ env: "dev-vm", clientFactory });
      let state = await loadState();
      expect(failed).toHaveLength(1);
      expect(state.notifications[0]?.status).toBe("delivery-failed");
      expect(state.notifications[0]?.lastError).toContain("subscriber unreachable");

      failDelivery = false;
      const retried = await deliverPendingNotifications({ env: "dev-vm", clientFactory });
      state = await loadState();
      expect(retried).toHaveLength(1);
      expect(sentMessages).toHaveLength(1);
      expect(state.notifications[0]?.status).toBe("delivered");
      expect(state.notifications[0]?.lastError).toBeNull();
    });
  });

  it("delivers notifications to an unsaved subscriber thread using subscriberEnvironment", async () => {
    await withTempState(async () => {
      await saveState({
        ...makeState(),
        agents: [makeAgent()],
        subscriptions: [
          makeSubscription({
            subscriberAgentName: null,
          }),
        ],
      });

      const { clientFactory, sentMessages } = createClientFactory({});

      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const delivered = await deliverPendingNotifications({ env: "dev-vm", clientFactory });
      const state = await loadState();

      expect(delivered).toHaveLength(1);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.threadId).toBe("thread-coordinator-a");
      expect(state.notifications[0]?.status).toBe("delivered");
      expect(state.notifications[0]?.subscriberAgentName).toBeNull();
    });
  });

  it("skips subscribed source agents whose remote thread no longer exists", async () => {
    // REGRESSION: stale saved agents/subscriptions should not make
    // `watch --once --no-deliver` fail for every other route.
    await withTempState(async () => {
      const clientFactory: WatchClientFactory = () => ({
        async findThread() {
          throw new Error("Thread thread-worker-a was not found");
        },
        async sendMessage() {
          throw new Error("sendMessage should not be called");
        },
      });

      const detected = await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const state = await loadState();

      expect(detected).toEqual([]);
      expect(state.notifications).toEqual([]);
    });
  });

  it("treats a subscribed running worker as outstanding watcher work", async () => {
    await withTempState(async () => {
      const { clientFactory } = createClientFactory({
        sourceThread: makeThread({
          latestTurn: {
            turnId: "turn-running",
            state: "running",
            requestedAt: "2026-04-17T00:00:00.000Z",
            startedAt: "2026-04-17T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          messages: [],
        }),
      });

      await expect(hasWatcherWork({ env: "dev-vm", clientFactory })).resolves.toBe(true);
    });
  });

  it("treats delivered notifications with no running subscriptions as idle", async () => {
    await withTempState(async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      await deliverPendingNotifications({ env: "dev-vm", clientFactory });

      await expect(hasWatcherWork({ env: "dev-vm", clientFactory })).resolves.toBe(false);
    });
  });
});
