import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
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
  claimPendingNotifications,
  decideWatcherExit,
  deliverPendingNotifications,
  detectAttentionEvents,
  hasActiveWork,
  unblockNotificationsForEnvironment,
  type WatchClient,
  type WatchClientFactory,
} from "../src/watch.js";

/** Higher than any real pid, so the liveness probe always reports "gone". */
const DEAD_PID = 2 ** 30;

function makeEnvironment(overrides: Partial<SavedEnvironment> = {}): SavedEnvironment {
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
    createdAt: "2026-09-05T00:00:00.000Z",
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
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:00.000Z",
    ...overrides,
  };
}

function makeCompletedThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  const id = overrides.id ?? "thread-worker-a";
  return {
    id,
    projectId: "project-1",
    title: "Worker",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: `turn-${id}`,
      state: "completed",
      requestedAt: "2026-09-05T00:00:00.000Z",
      startedAt: "2026-09-05T00:00:01.000Z",
      completedAt: "2026-09-05T00:00:02.000Z",
      assistantMessageId: `assistant-${id}`,
    },
    createdAt: "2026-09-05T00:00:00.000Z",
    updatedAt: "2026-09-05T00:00:02.000Z",
    archivedAt: null,
    messages: [
      {
        id: `assistant-${id}`,
        role: "assistant",
        text: "Worker finished and needs coordinator review.",
        turnId: `turn-${id}`,
        streaming: false,
        createdAt: "2026-09-05T00:00:02.000Z",
        updatedAt: "2026-09-05T00:00:02.000Z",
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeState(overrides: Partial<StateFile> = {}): StateFile {
  return {
    version: 1,
    environments: [makeEnvironment()],
    agents: [
      makeAgent(),
      makeAgent({ name: "coordinator-a", threadId: "thread-coordinator-a", title: "Coordinator" }),
    ],
    subscriptions: [makeSubscription()],
    notifications: [],
    ...overrides,
  };
}

function createClientFactory(input: {
  threads?: Record<string, OrchestrationThread>;
  onSend?: (message: { threadId: string; text: string }) => Promise<void> | void;
}): { clientFactory: WatchClientFactory; sent: Array<{ threadId: string; text: string }> } {
  const threads = input.threads ?? {
    "thread-worker-a": makeCompletedThread(),
    "thread-coordinator-a": makeCompletedThread({
      id: "thread-coordinator-a",
      latestTurn: null,
      messages: [],
    }),
  };
  const sent: Array<{ threadId: string; text: string }> = [];

  const clientFactory: WatchClientFactory = () => {
    const client: WatchClient = {
      async findThread(threadId) {
        const thread = threads[threadId];
        if (!thread) throw new Error(`Thread ${threadId} was not found`);
        return thread;
      },
      async sendMessage(message) {
        await input.onSend?.(message);
        sent.push({ threadId: message.threadId, text: message.text });
      },
    };
    return client;
  };

  return { clientFactory, sent };
}

async function withState(state: StateFile, test: () => Promise<void>): Promise<void> {
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-delivery-test-"));
  const previousStateFile = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(tempDir, "state.json");
  try {
    await saveState(state);
    await test();
  } finally {
    if (previousStateFile === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = previousStateFile;
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

describe("terminal recipients", () => {
  it("stops retrying and releases the watcher when the recipient is archived", async () => {
    // REGRESSION: an archived recipient used to fail delivery forever, which both
    // retried on every 5s scan and pinned the watcher open until its max lifetime.
    await withState(makeState(), async () => {
      const { clientFactory, sent } = createClientFactory({
        threads: {
          "thread-worker-a": makeCompletedThread(),
          "thread-coordinator-a": makeCompletedThread({
            id: "thread-coordinator-a",
            archivedAt: "2026-09-05T00:03:00.000Z",
            latestTurn: null,
            messages: [],
          }),
        },
      });

      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      await deliverPendingNotifications({ env: "dev-vm", clientFactory });

      let state = await loadState();
      expect(state.notifications[0]?.status).toBe("undeliverable");
      expect(state.notifications[0]?.lastError).toContain("archived");
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(false);

      // A later pass must not resurrect it, and re-detection must not either.
      await deliverPendingNotifications({ env: "dev-vm", clientFactory });
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      state = await loadState();
      expect(sent).toEqual([]);
      expect(state.notifications[0]?.status).toBe("undeliverable");
    });
  });

  it("gives up after the attempt cap instead of retrying forever", async () => {
    await withState(makeState(), async () => {
      const { clientFactory } = createClientFactory({
        onSend: () => {
          throw new Error("subscriber unreachable");
        },
      });

      await detectAttentionEvents({ env: "dev-vm", clientFactory });

      for (let attempt = 1; attempt <= 2; attempt += 1) {
        await deliverPendingNotifications({
          env: "dev-vm",
          clientFactory,
          maxAttempts: 2,
          // Each pass is far enough in the future to be past the backoff window.
          now: () => new Date(Date.now() + attempt * 3_600_000).toISOString(),
        });
      }

      const state = await loadState();
      expect(state.notifications[0]).toMatchObject({ status: "undeliverable", attempts: 2 });
      expect(state.notifications[0]?.lastError).toContain("gave up after 2 attempts");
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(false);
    });
  });
});

describe("retry backoff and ordering", () => {
  it("waits out the backoff window before retrying a failed delivery", async () => {
    // REGRESSION: `delivery-failed` was immediately retryable, so a failing route
    // was re-attempted on every scan with no spacing.
    await withState(makeState(), async () => {
      let failing = true;
      const { clientFactory, sent } = createClientFactory({
        onSend: () => {
          if (failing) throw new Error("subscriber unreachable");
        },
      });

      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      await deliverPendingNotifications({ env: "dev-vm", clientFactory });

      let state = await loadState();
      expect(state.notifications[0]?.status).toBe("delivery-failed");
      expect(state.notifications[0]?.attempts).toBe(1);
      expect(Date.parse(state.notifications[0]!.nextAttemptAt!)).toBeGreaterThan(Date.now());

      failing = false;
      // Immediately afterwards the notification is not due, so nothing is attempted.
      expect(await deliverPendingNotifications({ env: "dev-vm", clientFactory })).toEqual([]);
      expect(sent).toEqual([]);

      await deliverPendingNotifications({
        env: "dev-vm",
        clientFactory,
        now: () => new Date(Date.now() + 3_600_000).toISOString(),
      });
      state = await loadState();
      expect(state.notifications[0]?.status).toBe("delivered");
      expect(sent).toHaveLength(1);
    });
  });

  it("delivers one notification per recipient per pass, oldest first", async () => {
    await withState(
      makeState({
        agents: [
          makeAgent(),
          makeAgent({ name: "worker-b", threadId: "thread-worker-b", title: "Worker B" }),
          makeAgent({
            name: "coordinator-a",
            threadId: "thread-coordinator-a",
            title: "Coordinator",
          }),
        ],
        subscriptions: [
          makeSubscription(),
          makeSubscription({ sourceThreadId: "thread-worker-b", sourceAgentName: "worker-b" }),
        ],
      }),
      async () => {
        const { clientFactory, sent } = createClientFactory({
          threads: {
            "thread-worker-a": makeCompletedThread(),
            "thread-worker-b": makeCompletedThread({ id: "thread-worker-b" }),
            "thread-coordinator-a": makeCompletedThread({
              id: "thread-coordinator-a",
              latestTurn: null,
              messages: [],
            }),
          },
        });

        let tick = 0;
        await detectAttentionEvents({
          env: "dev-vm",
          clientFactory,
          now: () => new Date(Date.UTC(2026, 8, 5, 1, 0, (tick += 1))).toISOString(),
        });
        expect((await loadState()).notifications).toHaveLength(2);

        await deliverPendingNotifications({ env: "dev-vm", clientFactory });
        expect(sent).toHaveLength(1);
        const first = (await loadState()).notifications.filter(
          (notification) => notification.status === "delivered",
        );
        expect(first).toHaveLength(1);
        expect(first[0]?.sourceThreadId).toBe("thread-worker-a");

        await deliverPendingNotifications({ env: "dev-vm", clientFactory });
        expect(sent).toHaveLength(2);
        expect(
          (await loadState()).notifications.every(
            (notification) => notification.status === "delivered",
          ),
        ).toBe(true);
      },
    );
  });
});

describe("machine sleep", () => {
  it("does not steal its own in-flight claim after a long suspension", async () => {
    // REGRESSION: claim staleness was a pure wall-clock timeout, so a watcher that
    // slept mid-delivery re-claimed its own record on wake and sent it twice.
    await withState(makeState(), async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });

      const claimed = await claimPendingNotifications({ env: "dev-vm" });
      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.deliveryClaimPid).toBe(process.pid);

      const afterSleep = await claimPendingNotifications({
        env: "dev-vm",
        now: () => new Date(Date.now() + 8 * 3_600_000).toISOString(),
      });
      expect(afterSleep).toEqual([]);
    });
  });

  it("reclaims a claim stamped with a recycled pid by a dead watcher", async () => {
    // Our own pid on a claim we did not make: the kernel handed this pid to a new
    // watcher after the old one died mid-delivery. Without this the record would
    // never be retried and would keep the watcher awake forever.
    await withState(makeState(), async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const state = await loadState();
      await saveState({
        ...state,
        notifications: state.notifications.map((notification) => ({
          ...notification,
          status: "delivering" as const,
          updatedAt: "2026-09-05T00:00:00.000Z",
          lastAttemptedAt: "2026-09-05T00:00:00.000Z",
          deliveryClaimId: "claim-from-a-previous-watcher",
          deliveryClaimPid: process.pid,
        })),
      });

      const reclaimed = await claimPendingNotifications({ env: "dev-vm" });
      expect(reclaimed).toHaveLength(1);
    });
  });

  it("reclaims a delivery abandoned by a watcher that is gone", async () => {
    await withState(makeState(), async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const state = await loadState();
      await saveState({
        ...state,
        notifications: state.notifications.map((notification) => ({
          ...notification,
          status: "delivering" as const,
          deliveryClaimId: "claim-from-a-dead-watcher",
          deliveryClaimPid: DEAD_PID,
        })),
      });

      const reclaimed = await claimPendingNotifications({ env: "dev-vm" });
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0]?.deliveryClaimPid).toBe(process.pid);
    });
  });
});

describe("expired credentials", () => {
  it("parks delivery with an actionable error and resumes after re-pairing", async () => {
    // REGRESSION: an expired pairing surfaced only as a generic transport failure,
    // burned the retry budget, and kept the watcher spinning with nothing to do.
    await withState(
      makeState({ environments: [makeEnvironment({ expiresAt: "2026-09-04T00:00:00.000Z" })] }),
      async () => {
        const { clientFactory, sent } = createClientFactory({});

        await detectAttentionEvents({ env: "dev-vm", clientFactory });
        await deliverPendingNotifications({ env: "dev-vm", clientFactory });

        let state = await loadState();
        expect(state.notifications[0]?.status).toBe("blocked");
        expect(state.notifications[0]?.attempts).toBe(0);
        expect(state.notifications[0]?.lastError).toContain("t3-thread pair --name dev-vm");
        expect(sent).toEqual([]);
        // Nothing the watcher can do until a human re-pairs, so it may idle out.
        expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(false);

        const released = await unblockNotificationsForEnvironment("dev-vm");
        expect(released).toHaveLength(1);
        state = await loadState();
        await saveState({ ...state, environments: [makeEnvironment()] });

        await deliverPendingNotifications({ env: "dev-vm", clientFactory });
        expect((await loadState()).notifications[0]?.status).toBe("delivered");
        expect(sent).toHaveLength(1);
      },
    );
  });
});

describe("watcher expiry", () => {
  it("never idle-exits while work is outstanding", () => {
    expect(
      decideWatcherExit({
        elapsedMs: 60_000,
        idleMs: 900_000,
        idleExitMs: 900_000,
        maxLifetimeMs: 86_400_000,
        workRemaining: true,
      }),
    ).toEqual({ exit: false });
  });

  it("idle-exits once nothing is left to do", () => {
    expect(
      decideWatcherExit({
        elapsedMs: 60_000,
        idleMs: 900_000,
        idleExitMs: 900_000,
        maxLifetimeMs: 86_400_000,
        workRemaining: false,
      }),
    ).toEqual({ exit: true, reason: "idle", handoff: false });
  });

  it("hands off to a fresh watcher when the max lifetime expires with work left", () => {
    // REGRESSION: the max-lifetime backstop used to drop undelivered notifications
    // until some later CLI command happened to spawn another watcher.
    expect(
      decideWatcherExit({
        elapsedMs: 86_400_000,
        idleMs: 0,
        idleExitMs: 900_000,
        maxLifetimeMs: 86_400_000,
        workRemaining: true,
      }),
    ).toEqual({ exit: true, reason: "max-lifetime", handoff: true });

    expect(
      decideWatcherExit({
        elapsedMs: 86_400_000,
        idleMs: 0,
        idleExitMs: 900_000,
        maxLifetimeMs: 86_400_000,
        workRemaining: false,
      }),
    ).toEqual({ exit: true, reason: "max-lifetime", handoff: false });
  });

  it("keeps the idle-exit guard usable when an environment is no longer paired", async () => {
    // The watcher used to call a second, non-resilient guard that threw on an
    // unknown environment and killed the process. That guard is gone; this pins
    // that the one it now uses treats an unreachable route as "no work".
    await withState(
      makeState({
        subscriptions: [makeSubscription({ sourceEnvironment: "retired-vm" })],
        agents: [makeAgent({ environment: "retired-vm" })],
      }),
      async () => {
        const { clientFactory } = createClientFactory({});
        await expect(hasActiveWork({ env: "retired-vm", clientFactory })).resolves.toBe(false);
      },
    );
  });
});
