import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { projection, item } from "./v2-fixture.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { loadState, saveState } from "../src/state.js";
import { buildSubscriptionRecord } from "../src/state.js";
import { sendDirectResult } from "../src/directResult.js";
import { parseNotificationLevel } from "../src/notifications.js";
import type {
  OrchestrationThread,
  OrchestrationThreadShell,
  SavedAgent,
  SavedEnvironment,
  SavedSubscription,
  StateFile,
} from "../src/types.js";
import {
  deliverPendingNotifications,
  detectAttentionEvents,
  hasActiveWork,
  createWatchPoller,
  nextWatchInterval,
  scanAttentionNotifications,
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
    // Must stay in the future: delivery now parks on an expired pairing instead
    // of attempting a send that cannot authenticate.
    expiresAt: "2099-01-01T00:00:00.000Z",
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
    get projection() {
      const questions = this.activities.filter(
        (activity) => activity.kind === "user-input.requested" && activity.payload?.questions,
      );
      if (!questions.length) return undefined;
      return projection({
        turnItems: questions.map((activity) =>
          item("user_input_request", activity.createdAt, {
            requestId: activity.payload.requestId,
            questions: activity.payload.questions.map(
              (question: { id: string; question: string; options: Array<{ label: string }> }) => ({
                ...question,
                header: "Question",
                options: question.options.map((option) => ({ ...option, description: "Choice" })),
              }),
            ),
          }),
        ),
      });
    },
    get runtimeRequests() {
      const pending = new Map<string, { id: string; kind: string; status: "pending" }>();
      for (const activity of this.activities) {
        const id = String(activity.payload?.requestId);
        if (activity.kind.endsWith(".requested"))
          pending.set(id, {
            id,
            status: "pending",
            kind: activity.kind.startsWith("user-input") ? "user_input" : "approval",
          });
        else if (activity.kind.endsWith(".resolved")) pending.delete(id);
      }
      return [...pending.values()];
    },
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
        sentMessages.push({ threadId: message.threadId, text: message.text });
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
  const tempDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-thread-watch-test-"));
  const stateFile = NodePath.join(tempDir, "state.json");
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
    await NodeFSP.rm(tempDir, { recursive: true, force: true });
  }
}

describe("watch flows", () => {
  it("reports the final completion of a worker that settled itself right after its turn", async () => {
    await withTempState(async () => {
      const settled = (settledAt: string) => makeThread({ settledOverride: "settled", settledAt });
      const { clientFactory } = createClientFactory({
        sourceThread: settled("2026-04-17T00:00:04.000Z"),
      });
      const events = await scanAttentionNotifications(await loadState(), {
        clientFactory,
        now: () => "2026-04-17T00:00:30.000Z",
      });
      expect(events).toMatchObject([{ sourceState: "completed", latestTurnId: "turn-1" }]);

      const stale = createClientFactory({ sourceThread: settled("2026-04-17T00:00:04.000Z") });
      expect(
        await scanAttentionNotifications(await loadState(), {
          clientFactory: stale.clientFactory,
          now: () => "2026-04-17T03:00:00.000Z",
        }),
      ).toEqual([]);
    });
  });

  it("reads a settled source only while its completion can still be reported", async () => {
    await withTempState(async () => {
      const completedAt = "2026-04-17T00:00:04.000Z";
      const source = makeThread({
        settledOverride: "settled",
        settledAt: completedAt,
        latestTurn: { ...makeThread().latestTurn!, completedAt },
      });
      const shell = {
        ...source,
        activeRunId: null,
        latestUserMessageAt: null,
        hasPendingApprovals: false,
        hasPendingUserInput: false,
        hasActionableProposedPlan: false,
      } as OrchestrationThreadShell;
      const base = createClientFactory({ sourceThread: source });
      let sourceReads = 0;
      const clientFactory: WatchClientFactory = (environment) => ({
        ...base.clientFactory(environment),
        listThreads: async () => [shell],
        async findThread(threadId) {
          if (threadId === source.id) sourceReads += 1;
          return base.clientFactory(environment).findThread(threadId);
        },
      });

      // Just settled: the completion notice is still read and reported.
      expect(
        await scanAttentionNotifications(await loadState(), {
          clientFactory,
          now: () => "2026-04-17T00:00:30.000Z",
        }),
      ).toMatchObject([{ sourceState: "completed", latestTurnId: "turn-1" }]);
      expect(sourceReads).toBe(1);

      // Hours later the shell already says nothing can be reported: no full read.
      expect(
        await scanAttentionNotifications(await loadState(), {
          clientFactory,
          now: () => "2026-04-17T03:00:00.000Z",
        }),
      ).toEqual([]);
      expect(await hasActiveWork({ clientFactory })).toBe(false);
      expect(sourceReads).toBe(1);
    });
  });

  it("stays awake just long enough to record a completion that settled before the next pass", async () => {
    await withTempState(async () => {
      const finishedAt = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
      const settledWorker = (agoMs: number) =>
        makeThread({
          settledOverride: "settled",
          settledAt: finishedAt(agoMs),
          latestTurn: { ...makeThread().latestTurn!, completedAt: finishedAt(agoMs) },
        });
      const recent = createClientFactory({ sourceThread: settledWorker(10_000) });
      expect(await hasActiveWork({ clientFactory: recent.clientFactory })).toBe(true);
      const old = createClientFactory({ sourceThread: settledWorker(10 * 60_000) });
      expect(await hasActiveWork({ clientFactory: old.clientFactory })).toBe(false);
    });
  });

  it("holds and coalesces new notifications against a persisted quota failure, then recovers on explicit retry", async () => {
    await withTempState(async () => {
      const subscriber = makeThread({
        id: "thread-coordinator-a",
        latestTurn: { ...makeThread().latestTurn!, state: "error" },
        session: {
          threadId: "thread-coordinator-a",
          status: "error",
          providerName: "claudeAgent",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: "Claude usage limit reached. Send the message again once the limit resets.",
          updatedAt: "2026-04-17T00:00:02.000Z",
        },
      });
      const source = makeThread();
      const { clientFactory, sentMessages } = createClientFactory({
        sourceThread: source,
        subscriberThread: subscriber,
      });
      const now = () => "2026-04-17T01:00:00.000Z";
      await detectAttentionEvents({ clientFactory, now });
      const legacyState = await loadState();
      legacyState.notifications.push({
        ...legacyState.notifications[0]!,
        id: "older-record",
        eventKey: "older-event",
        latestTurnId: "old-turn",
      });
      await saveState(legacyState);
      // Re-detect the already persisted current event: old versions can leave a backlog.
      await detectAttentionEvents({ clientFactory, now });
      expect(
        (await loadState()).notifications.find((event) => event.id === "older-record")?.status,
      ).toBe("superseded");
      await deliverPendingNotifications({ clientFactory, now });
      source.latestTurn = { ...source.latestTurn!, turnId: "turn-2" };
      await detectAttentionEvents({ clientFactory, now });
      await deliverPendingNotifications({ clientFactory, now });
      const state = await loadState();
      expect(sentMessages).toHaveLength(0);
      expect(state.notifications.map((event) => event.status).sort()).toEqual([
        "held",
        "superseded",
        "superseded",
      ]);
      // Restart with persisted records, then an explicit user turn succeeds.
      await saveState(state);
      subscriber.activities = [
        {
          kind: "runtime.error",
          turnId: "turn-1",
          payload: { message: subscriber.session!.lastError },
        },
      ];
      subscriber.session = null;
      await deliverPendingNotifications({ clientFactory, now: () => "2026-04-17T01:02:00.000Z" });
      expect(sentMessages).toHaveLength(0);
      subscriber.latestTurn = {
        ...subscriber.latestTurn!,
        turnId: "explicit-retry",
        state: "completed",
      };
      await deliverPendingNotifications({ clientFactory, now: () => "2026-04-17T01:04:00.000Z" });
      expect(sentMessages).toHaveLength(1);
      expect(
        (await loadState()).notifications.filter((event) => event.status === "delivered"),
      ).toHaveLength(1);
    });
  });

  it("releases quota holds at a structured reset, but never bypasses settlement or retries an already expired failed window", async () => {
    await withTempState(async () => {
      const subscriber = makeThread({
        id: "thread-coordinator-a",
        latestTurn: { ...makeThread().latestTurn!, state: "error" },
        activities: [
          {
            kind: "runtime.warning",
            turnId: "turn-1",
            createdAt: "2026-04-17T00:00:01.000Z",
            payload: {
              detail: {
                status: "rejected",
                rateLimitType: "five_hour",
                resetsAt: Date.parse("2026-04-17T02:00:00.000Z") / 1000,
              },
            },
          },
        ],
      });
      const { clientFactory, sentMessages } = createClientFactory({ subscriberThread: subscriber });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory, now: () => "2026-04-17T01:00:00.000Z" });
      expect(sentMessages).toHaveLength(0);
      expect(await hasActiveWork({ clientFactory })).toBe(true);
      subscriber.settledOverride = "settled";
      await deliverPendingNotifications({ clientFactory, now: () => "2026-04-17T02:01:00.000Z" });
      expect(sentMessages).toHaveLength(0);
      expect(await hasActiveWork({ clientFactory })).toBe(false);
      subscriber.settledOverride = null;
      await deliverPendingNotifications({ clientFactory, now: () => "2026-04-17T02:03:00.000Z" });
      expect(sentMessages).toHaveLength(1);
      // A new failure after that same reset must await explicit retry.
      subscriber.latestTurn = {
        ...subscriber.latestTurn!,
        turnId: "turn-2",
        completedAt: "2026-04-17T02:03:01.000Z",
      };
      subscriber.activities[0]!.turnId = "turn-2";
      const source = makeThread({
        latestTurn: { ...makeThread().latestTurn!, turnId: "source-2" },
      });
      const again = createClientFactory({ sourceThread: source, subscriberThread: subscriber });
      await detectAttentionEvents({ clientFactory: again.clientFactory });
      await deliverPendingNotifications({
        clientFactory: again.clientFactory,
        now: () => "2026-04-17T02:05:00.000Z",
      });
      expect(again.sentMessages).toHaveLength(0);
    });
  });

  it("delivers normally after provider recovery and when provisioned overage permits work", async () => {
    for (const state of ["completed", "error"] as const) {
      await withTempState(async () => {
        const subscriber = makeThread({
          id: "thread-coordinator-a",
          latestTurn: { ...makeThread().latestTurn!, state },
          activities: [
            {
              kind: "runtime.warning",
              turnId: "turn-1",
              createdAt: "2026-04-17T00:00:01.000Z",
              payload: {
                detail: {
                  status: "rejected",
                  rateLimitType: "five_hour",
                  resetsAt: 9999999999,
                  ...(state === "error" ? { isUsingOverage: true } : {}),
                },
              },
            },
          ],
        });
        const { clientFactory, sentMessages } = createClientFactory({
          subscriberThread: subscriber,
        });
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(1);
      });
    }
  });

  it("suppresses routed quota-error cascades while preserving ordinary errors and pending requests", async () => {
    await withTempState(async () => {
      const source = makeThread({
        latestTurn: { ...makeThread().latestTurn!, state: "error" },
        messages: [
          {
            ...makeThread().messages[0]!,
            role: "user",
            text: "HomeNetwork orchestrator notification: Worker needs attention",
          },
        ],
        activities: [{ kind: "runtime.error", turnId: "turn-1", payload: { code: "usage_limit" } }],
      });
      const { clientFactory } = createClientFactory({ sourceThread: source });
      expect(await detectAttentionEvents({ clientFactory })).toHaveLength(0);
      for (const request of [
        { kind: "approval.requested", payload: { requestId: "approve-1" } },
        {
          kind: "user-input.requested",
          payload: {
            requestId: "input-1",
            questions: [{ id: "q1", question: "Which host?", options: [] }],
          },
        },
      ]) {
        source.activities.push({
          ...request,
          turnId: "turn-1",
          createdAt: "2026-04-17T00:00:03.000Z",
        });
        expect(await detectAttentionEvents({ clientFactory })).toHaveLength(1);
        source.activities.pop();
      }
      source.activities = [];
      expect(await detectAttentionEvents({ clientFactory })).toHaveLength(1);
      source.activities = [
        { kind: "runtime.error", turnId: "turn-1", payload: { code: "usage_limit" } },
      ];
      source.messages[0]!.text = "Please try again";
      expect(await detectAttentionEvents({ clientFactory })).toHaveLength(1);
    });
  });

  it("records native queued acceptance when a busy recipient races its snapshot", async () => {
    await withTempState(async () => {
      const factory = createClientFactory({});
      await detectAttentionEvents({ clientFactory: factory.clientFactory });
      const clientFactory: WatchClientFactory = (environment) => ({
        ...factory.clientFactory(environment),
        supportsReliableHandoffs: async () => true,
        sendMessage: async (input) => ({
          dispatched: false,
          queued: true,
          receipt: { sendId: input.commandId, status: "queued" },
        }),
      });
      const attempted = await deliverPendingNotifications({ clientFactory });
      expect(attempted[0]?.status).toBe("delivered");
      expect((await loadState()).queuedSends).toEqual([]);
    });
  });

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

  it("preserves uncertain transport failures without automatic retry on later passes", async () => {
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
      expect(state.notifications[0]?.status).toBe("uncertain");
      expect(state.notifications[0]?.lastError).toBe("TRANSPORT_ERROR");

      failDelivery = false;
      // Time and a healthy transport do not resolve the missing acknowledgment.
      expect(await deliverPendingNotifications({ env: "dev-vm", clientFactory })).toEqual([]);
      const retried = await deliverPendingNotifications({
        env: "dev-vm",
        clientFactory,
        now: () => new Date(Date.now() + 3_600_000).toISOString(),
      });
      state = await loadState();
      expect(retried).toHaveLength(0);
      expect(sentMessages).toHaveLength(0);
      expect(state.notifications[0]?.status).toBe("uncertain");
      expect(state.notifications[0]?.lastError).toBe("TRANSPORT_ERROR");
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

  it("does not route attention that predates the subscription", async () => {
    // REGRESSION (t3code-fork#49): subscribing to a source that had already
    // completed or errored fired that stale state at the subscriber immediately.
    await withTempState(async () => {
      await saveState({
        ...makeState(),
        subscriptions: [makeSubscription({ baselineTurnId: "turn-1" })],
      });
      const { clientFactory } = createClientFactory({});

      expect(await detectAttentionEvents({ env: "dev-vm", clientFactory })).toEqual([]);
      expect((await loadState()).notifications).toEqual([]);

      const laterTurn = createClientFactory({
        sourceThread: makeThread({
          latestTurn: {
            turnId: "turn-2",
            state: "completed",
            requestedAt: "2026-04-17T00:01:00.000Z",
            startedAt: "2026-04-17T00:01:01.000Z",
            completedAt: "2026-04-17T00:01:02.000Z",
            assistantMessageId: "assistant-2",
          },
          messages: [
            {
              id: "assistant-2",
              role: "assistant",
              text: "Second turn finished.",
              turnId: "turn-2",
              streaming: false,
              createdAt: "2026-04-17T00:01:02.000Z",
              updatedAt: "2026-04-17T00:01:02.000Z",
            },
          ],
        }),
      });
      const detected = await detectAttentionEvents({
        env: "dev-vm",
        clientFactory: laterTurn.clientFactory,
      });
      expect(detected).toHaveLength(1);
      expect(detected[0]?.latestTurnId).toBe("turn-2");
    });
  });

  it("supersedes undelivered events when the source moves on before delivery", async () => {
    // REGRESSION (t3code-fork#49): a source that completed several short turns
    // in a row produced one pending event per turn, and the backlog was then
    // delivered one recipient turn at a time, re-announcing stale states.
    await withTempState(async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      expect((await loadState()).notifications.map((n) => n.status)).toEqual(["pending"]);

      const laterTurn = createClientFactory({
        sourceThread: makeThread({
          latestTurn: {
            turnId: "turn-2",
            state: "completed",
            requestedAt: "2026-04-17T00:01:00.000Z",
            startedAt: "2026-04-17T00:01:01.000Z",
            completedAt: "2026-04-17T00:01:02.000Z",
            assistantMessageId: "assistant-2",
          },
          messages: [
            {
              id: "assistant-2",
              role: "assistant",
              text: "Second turn finished.",
              turnId: "turn-2",
              streaming: false,
              createdAt: "2026-04-17T00:01:02.000Z",
              updatedAt: "2026-04-17T00:01:02.000Z",
            },
          ],
        }),
      });
      await detectAttentionEvents({ env: "dev-vm", clientFactory: laterTurn.clientFactory });
      let state = await loadState();
      const byMessage = Object.fromEntries(
        state.notifications.map((n) => [n.latestAssistantMessageId, n.status]),
      );
      expect(byMessage).toEqual({ "assistant-1": "superseded", "assistant-2": "pending" });

      // Re-detecting the same current event must not disturb anything.
      await detectAttentionEvents({ env: "dev-vm", clientFactory: laterTurn.clientFactory });
      expect((await loadState()).notifications).toHaveLength(2);

      const delivered = await deliverPendingNotifications({
        env: "dev-vm",
        clientFactory: laterTurn.clientFactory,
      });
      state = await loadState();
      expect(delivered).toHaveLength(1);
      expect(laterTurn.sentMessages).toHaveLength(1);
      expect(laterTurn.sentMessages[0]?.text).toContain("Second turn finished");
      expect(
        state.notifications.find((n) => n.latestAssistantMessageId === "assistant-1")?.status,
      ).toBe("superseded");
      expect(await hasActiveWork({ env: "dev-vm", clientFactory: laterTurn.clientFactory })).toBe(
        false,
      );
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
});

describe("hasActiveWork (idle-exit guard)", () => {
  it("returns false when nothing is subscribed and no notifications are pending", async () => {
    await withTempState(async () => {
      await saveState({ ...makeState(), subscriptions: [], notifications: [] });
      const { clientFactory } = createClientFactory({});
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(false);
    });
  });

  it("returns true while a subscribed source thread is still running", async () => {
    // REGRESSION: the watcher must not idle-exit while a watched thread is mid-run,
    // or it would never deliver the completion it exists to deliver.
    await withTempState(async () => {
      const runningSource = makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: "2026-04-17T00:00:00.000Z",
          startedAt: "2026-04-17T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
        messages: [],
      });
      const { clientFactory } = createClientFactory({ sourceThread: runningSource });
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(true);
    });
  });

  it("returns false when the subscribed source completed and nothing is undelivered", async () => {
    await withTempState(async () => {
      const { clientFactory } = createClientFactory({});
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(false);
    });
  });

  it("returns true while a detected notification is still undelivered", async () => {
    await withTempState(async () => {
      const { clientFactory } = createClientFactory({});
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      expect(await hasActiveWork({ env: "dev-vm", clientFactory })).toBe(true);
    });
  });
});

describe("notification ownership and attention", () => {
  it.each(["approval", "user-input"] as const)(
    "delivers %s requests from full snapshots without assistant output",
    async (kind) => {
      await withTempState(async () => {
        const source = makeThread({
          messages: [],
          latestTurn: { ...makeThread().latestTurn!, state: "running", assistantMessageId: null },
          activities: [
            {
              kind: kind === "approval" ? "approval.requested" : "user-input.requested",
              createdAt: "2026-04-17T00:00:03.000Z",
              payload: {
                requestId: "request-1",
                questions: [{ id: "q", question: "Choose?", options: [] }],
              },
            },
          ],
        });
        const { clientFactory, sentMessages } = createClientFactory({ sourceThread: source });
        expect(await detectAttentionEvents({ clientFactory })).toHaveLength(1);
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]!.text).toContain(
          kind === "approval" ? "needs-approval" : "needs-input",
        );
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(1);
      });
    },
  );

  it("suppresses notification replies while preserving real completions and explicit attention", async () => {
    await withTempState(async () => {
      const source = makeThread();
      source.messages.unshift({
        ...source.messages[0]!,
        id: "notification",
        role: "user",
        text: "HomeNetwork orchestrator notification: child completed a turn.",
      });
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread: source });
      expect(await detectAttentionEvents({ clientFactory })).toEqual([]);
      source.activities.push({
        kind: "approval.requested",
        createdAt: "2026-04-17T00:00:03.000Z",
        payload: { requestId: "request-1" },
      });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(1);
      source.activities.push({
        kind: "approval.resolved",
        createdAt: "2026-04-17T00:00:04.000Z",
        payload: { requestId: "request-1" },
      });
      source.messages.push({
        ...source.messages[0]!,
        id: "real-instruction",
        role: "user",
        text: "Do the next task.",
      });
      expect(await detectAttentionEvents({ clientFactory })).toHaveLength(1);
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]!.text).toContain("completed a turn");
    });
  });

  it("lets multiple supervisors opt into attention without changing completion routes", async () => {
    await withTempState(async () => {
      const state = await loadState();
      state.subscriptions.push(
        makeSubscription({ subscriberThreadId: "attention-supervisor", level: "attention" }),
      );
      await saveState(state);
      const source = makeThread();
      const { clientFactory } = createClientFactory({ sourceThread: source });
      expect(
        (await detectAttentionEvents({ clientFactory })).map((event) => event.subscriberThreadId),
      ).toEqual(["thread-coordinator-a"]);
      source.activities.push({
        kind: "approval.requested",
        createdAt: "2026-04-17T00:00:03.000Z",
        payload: { requestId: "approval" },
      });
      const attention = await detectAttentionEvents({ clientFactory });
      expect(attention.map((event) => event.subscriberThreadId)).toEqual([
        "thread-coordinator-a",
        "attention-supervisor",
      ]);
      expect(new Set((await loadState()).notifications.map((event) => event.eventKey)).size).toBe(
        3,
      );
    });
  });

  it("preserves delivered events with historical keys instead of replaying them", async () => {
    await withTempState(async () => {
      const { clientFactory, sentMessages } = createClientFactory({});
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      const state = await loadState();
      state.notifications[0]!.eventKey =
        "thread-coordinator-a:thread-worker-a:assistant:assistant-1";
      await saveState(state);
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(1);
      expect((await loadState()).notifications).toHaveLength(1);
    });
  });
});

describe("watch polling cost", () => {
  it("re-reads a quiet source only when its shell changes, and a live one at most every 30 s", async () => {
    let time = 0;
    const thread = makeThread({ id: "worker" });
    let shell = {
      ...thread,
      activeRunId: null,
      status: "idle",
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } as OrchestrationThreadShell;
    let reads = 0;
    let lists = 0;
    const poller = createWatchPoller(
      () => ({
        async listThreads() {
          lists += 1;
          return [shell];
        },
        async findThread() {
          reads += 1;
          return thread;
        },
        async sendMessage() {},
      }),
      () => time,
    );
    const client = poller.clientFactory(makeEnvironment());
    const pass = async (advanceMs = 5_000) => {
      time += advanceMs;
      poller.beginPoll();
      await client.listThreads!();
      await client.listThreads!();
      await client.findThread("worker");
    };
    await pass();
    await pass();
    await pass();
    // Quiet and unchanged: one full read, and one shell list per 15 s however often passes run.
    expect(reads).toBe(1);
    expect(lists).toBe(1);
    shell = { ...shell, updatedAt: "2026-04-17T01:00:00.000Z" };
    await pass(15_000);
    expect(reads).toBe(2);
    // Live: read on starting, then at most every 30 s while nothing in its shell moves.
    shell = { ...shell, activeRunId: "run-2", status: "running" };
    await pass(15_000);
    await pass(15_000);
    expect(reads).toBe(3);
    await pass(15_000);
    expect(reads).toBe(4);
    // A request on the live run shows in the shell and is read at once.
    shell = { ...shell, hasPendingUserInput: true };
    await pass(15_000);
    expect(reads).toBe(5);
  });

  it("shares reads and parks missing, archived and settled sources", async () => {
    let time = 0;
    const calls: string[] = [];
    const poller = createWatchPoller(
      () => ({
        async findThread(id) {
          calls.push(id);
          if (id === "missing") throw new Error("Thread missing was not found");
          return makeThread(
            id === "archived"
              ? { archivedAt: "2026-01-01" }
              : { settledOverride: time < 60_000 ? "settled" : null },
          );
        },
        async sendMessage() {},
      }),
      () => time,
    );
    const client = poller.clientFactory(makeEnvironment());
    await client.findThread("settled");
    await client.findThread("settled");
    await client.findThread("archived");
    await expect(client.findThread("missing")).rejects.toThrow("was not found");
    poller.beginPoll();
    await client.findThread("settled");
    await client.findThread("archived");
    await expect(client.findThread("missing")).rejects.toThrow("was not found");
    expect(calls).toEqual(["settled", "archived", "missing"]);
    time = 60_000;
    poller.beginPoll();
    expect((await client.findThread("settled")).settledOverride).toBeNull();
    await client.findThread("archived");
    expect(calls).toEqual(["settled", "archived", "missing", "settled"]);
    expect(poller.skippedMappings()).toEqual([
      { mapping: "dev-vm:archived", reason: "archived" },
      { mapping: "dev-vm:missing", reason: "missing" },
    ]);
  });

  it("ignores unsubscribed and terminal sources without creating attention events", async () => {
    const state: StateFile = {
      version: 1,
      environments: [makeEnvironment()],
      agents: [makeAgent()],
      subscriptions: [],
      notifications: [],
      queuedSends: [],
    };
    let reads = 0;
    const clientFactory: WatchClientFactory = () => ({
      async findThread() {
        reads++;
        return makeThread({ settledOverride: "settled" });
      },
      async sendMessage() {},
    });
    expect(await scanAttentionNotifications(state, { clientFactory })).toEqual([]);
    expect(reads).toBe(0);
    state.subscriptions = [makeSubscription()];
    expect(await scanAttentionNotifications(state, { clientFactory })).toEqual([]);
    expect(reads).toBe(1);
  });

  it("backs off idle polls and resumes the configured active cadence", () => {
    expect(nextWatchInterval(5000, false)).toBe(60_000);
    expect(nextWatchInterval(5000, true)).toBe(5000);
    expect(nextWatchInterval(120_000, false)).toBe(120_000);
  });
});

describe("notification preferences", () => {
  it("validates levels and preserves route receipts when changing preference", () => {
    expect(parseNotificationLevel("attention")).toBe("attention");
    expect(() => parseNotificationLevel("quiet")).toThrow("all, attention, or none");
    const existing = makeSubscription({
      lastDirectMessageTurnId: "turn-1",
      baselineTurnId: "old-turn",
    });
    const next = buildSubscriptionRecord(
      {
        threadId: existing.subscriberThreadId,
        name: existing.subscriberAgentName,
        environment: existing.subscriberEnvironment,
      },
      {
        threadId: existing.sourceThreadId,
        name: existing.sourceAgentName,
        environment: existing.sourceEnvironment,
      },
      "2026-10-01T00:00:00Z",
      existing,
      { level: "attention" },
    );
    expect(next.level).toBe("attention");
    expect(next.baselineTurnId).toBe("old-turn");
    expect(next.lastDirectMessageTurnId).toBe("turn-1");
  });

  it.each([false, true])(
    "records a successful direct result (queued=%s) only for its recipient and turn",
    async (queued) => {
      await withTempState(async () => {
        const state = await loadState();
        state.subscriptions.push(makeSubscription({ subscriberThreadId: "other-subscriber" }));
        await saveState(state);
        const result = await sendDirectResult({
          callerThreadId: "thread-worker-a",
          subscriberThreadId: "thread-coordinator-a",
          getSourceTurn: async (route) => {
            expect(route.sourceEnvironment).toBe("dev-vm");
            return "turn-1";
          },
          send: async () => ({ queued }),
        });
        expect(result).toEqual({ queued });
        const saved = await loadState();
        expect(saved.subscriptions[0]!.lastDirectMessageTurnId).toBe("turn-1");
        expect(saved.subscriptions[1]!.lastDirectMessageTurnId).toBeUndefined();
      });
    },
  );

  it("does not suppress completion for a rejected direct send", async () => {
    await withTempState(async () => {
      await expect(
        sendDirectResult({
          callerThreadId: "thread-worker-a",
          subscriberThreadId: "thread-coordinator-a",
          getSourceTurn: async () => "turn-1",
          send: async () => {
            throw new Error("send failed");
          },
        }),
      ).rejects.toThrow("send failed");
      expect((await loadState()).subscriptions[0]!.lastDirectMessageTurnId).toBeUndefined();
    });
  });
  it("defaults to all and changes a subscription without losing its direct-send receipt", async () => {
    await withTempState(async () => {
      const { clientFactory, sentMessages } = createClientFactory({});
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(1);
    });
  });

  it.each(["all", "attention", "none"] as const)(
    "always delivers required approval at %s even without assistant output",
    async (level) => {
      await withTempState(async () => {
        const state = await loadState();
        state.subscriptions[0]!.level = level;
        await saveState(state);
        const sourceThread = makeThread({
          messages: [],
          activities: [
            {
              kind: "approval.requested",
              createdAt: "2026-10-01T00:00:00Z",
              payload: { requestId: "approve-1", requestType: "command" },
            },
          ],
        });
        const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]!.text).toContain("needs-approval");
      });
    },
  );

  it.each(["all", "attention", "none"] as const)(
    "delivers input and errors despite quiet completion at %s",
    async (level) => {
      await withTempState(async () => {
        const state = await loadState();
        state.subscriptions[0]!.level = level;
        state.subscriptions[0]!.baselineTurnId = "turn-1";
        await saveState(state);
        const sourceThread = makeThread();
        sourceThread.messages[0]!.text = "T3_NOTIFY: quiet";
        sourceThread.activities = [
          {
            kind: "user-input.requested",
            createdAt: "2026-10-01T00:00:00Z",
            payload: {
              requestId: "input-1",
              questions: [{ id: "q1", question: "Choose", header: "Choice", options: [] }],
            },
          },
        ];
        const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(1);
        expect(sentMessages[0]!.text).toContain("needs-input");
        sourceThread.activities = [];
        sourceThread.latestTurn!.state = "error";
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(2);
        expect(sentMessages[1]!.text).toContain("error");
      });
    },
  );

  it.each([
    ["all", 1],
    ["attention", 1],
    ["none", 0],
  ] as const)("interruption at %s sends %s notices", async (level, count) => {
    await withTempState(async () => {
      const state = await loadState();
      state.subscriptions[0]!.level = level;
      await saveState(state);
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = "interrupted";
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(count);
    });
  });

  it("rechecks a direct result recorded after detection before sending completion", async () => {
    await withTempState(async () => {
      const state = await loadState();
      state.subscriptions[0]!.level = "attention";
      await saveState(state);
      const sourceThread = makeThread();
      sourceThread.messages[0]!.text = "T3_NOTIFY: attention";
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
      await detectAttentionEvents({ clientFactory });
      await sendDirectResult({
        callerThreadId: sourceThread.id,
        subscriberThreadId: "thread-coordinator-a",
        getSourceTurn: async () => "turn-1",
        send: async () => ({ queued: true }),
      });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(0);
      expect((await loadState()).notifications[0]!.status).toBe("superseded");
    });
  });

  it.each([
    ["all", undefined, "ordinary", 1],
    ["attention", undefined, "ordinary", 0],
    ["none", undefined, "ordinary", 0],
    ["all", undefined, "T3_NOTIFY: quiet", 0],
    ["attention", undefined, "T3_NOTIFY: attention", 1],
    ["attention", "turn-1", "T3_NOTIFY: attention", 0],
    ["attention", "old-turn", "T3_NOTIFY: attention", 1],
    ["all", "turn-1", "T3_NOTIFY: attention", 1],
    ["none", undefined, "T3_NOTIFY: attention", 0],
  ] as const)(
    "completion %s direct=%s result=%s sends %s notices",
    async (level, receipt, text, count) => {
      await withTempState(async () => {
        const state = await loadState();
        state.subscriptions[0]!.level = level;
        state.subscriptions[0]!.lastDirectMessageTurnId = receipt;
        await saveState(state);
        const sourceThread = makeThread();
        sourceThread.messages[0]!.text = text;
        const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
        await detectAttentionEvents({ clientFactory });
        await deliverPendingNotifications({ clientFactory });
        expect(sentMessages).toHaveLength(count);
      });
    },
  );

  it("merges concurrent detectors into one error episode and one delivery", async () => {
    await withTempState(async () => {
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = "error";
      const { clientFactory: factory, sentMessages } = createClientFactory({ sourceThread });
      let arrivals = 0;
      let release!: () => void;
      const bothLoaded = new Promise<void>((resolve) => {
        release = resolve;
      });
      const clientFactory: WatchClientFactory = (environment) => {
        const client = factory(environment);
        return {
          ...client,
          async findThread(id) {
            if (id === sourceThread.id) {
              if (++arrivals === 2) release();
              await bothLoaded;
            }
            return client.findThread(id);
          },
        };
      };
      await Promise.all([
        detectAttentionEvents({ clientFactory }),
        detectAttentionEvents({ clientFactory }),
      ]);
      const state = await loadState();
      expect(state.notifications).toHaveLength(1);
      expect(state.notifications[0]!.occurrences).toBe(1);
      await deliverPendingNotifications({ clientFactory: factory });
      expect(sentMessages).toHaveLength(1);
    });
  });

  it("does not overwrite another environment's newer error episode with a stale snapshot", async () => {
    await withTempState(async () => {
      const state = await loadState();
      state.environments.push(makeEnvironment({ name: "other", environmentId: "env-2" }));
      state.agents.push(
        makeAgent({ name: "worker-b", threadId: "thread-worker-b", environment: "other" }),
      );
      state.subscriptions.push(
        makeSubscription({
          sourceThreadId: "thread-worker-b",
          sourceAgentName: "worker-b",
          sourceEnvironment: "other",
        }),
      );
      await saveState(state);
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = "error";
      const second = makeThread({ id: "thread-worker-b" });
      second.latestTurn!.state = "error";
      const { clientFactory: factory } = createClientFactory({ sourceThread });
      let resume!: () => void;
      let observed!: () => void;
      const held = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const loaded = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const clientFactory: WatchClientFactory = (environment) => ({
        ...factory(environment),
        async findThread(id) {
          if (id === second.id) {
            observed();
            await held;
            return second;
          }
          return factory(environment).findThread(id);
        },
      });
      const otherScan = detectAttentionEvents({ env: "other", clientFactory });
      await loaded;
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      const episode = (await loadState()).subscriptions[0]!.errorEventKey;
      expect(episode).toBeTruthy();
      resume();
      await otherScan;
      expect((await loadState()).subscriptions[0]!.errorEventKey).toBe(episode);
      await detectAttentionEvents({ env: "dev-vm", clientFactory });
      expect((await loadState()).notifications).toHaveLength(2);
    });
  });

  it("collapses identical errors across turns, counts distinct failures rather than scans, and resets after recovery", async () => {
    await withTempState(async () => {
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = "error";
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      sourceThread.latestTurn!.turnId = "turn-2";
      sourceThread.messages[0]!.id = "assistant-2";
      await detectAttentionEvents({ clientFactory });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(1);
      expect((await loadState()).notifications[0]!.occurrences).toBe(2);
      sourceThread.latestTurn!.state = "running";
      await detectAttentionEvents({ clientFactory });
      sourceThread.latestTurn!.state = "error";
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(2);
    });
  });

  it("delivers a new input request in the same turn after an earlier notification", async () => {
    await withTempState(async () => {
      const sourceThread = makeThread();
      const request = (id: string) => ({
        kind: "user-input.requested",
        createdAt: "2026-10-01T00:00:00Z",
        payload: {
          requestId: id,
          questions: [{ id: "q1", question: "Choose", header: "Choice", options: [] }],
        },
      });
      sourceThread.activities = [request("input-1")];
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      sourceThread.activities.push(
        {
          kind: "user-input.resolved",
          createdAt: "2026-10-01T00:01:00Z",
          payload: { requestId: "input-1" },
        },
        request("input-2"),
      );
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]!.text).toContain("needs-input");
    });
  });

  it("delivers collapsed error counts after a busy subscriber and resets on a different reason", async () => {
    await withTempState(async () => {
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = "error";
      const subscriberThread = makeThread({
        id: "thread-coordinator-a",
        latestTurn: { ...sourceThread.latestTurn!, state: "running" },
        messages: [],
      });
      const { clientFactory, sentMessages } = createClientFactory({
        sourceThread,
        subscriberThread,
      });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      sourceThread.latestTurn!.turnId = "second-failure";
      await detectAttentionEvents({ clientFactory });
      subscriberThread.latestTurn = null;
      await deliverPendingNotifications({ clientFactory, now: () => "2090-01-01T00:00:00Z" });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.text).toContain("Occurrences: 2.");
      sourceThread.session = {
        threadId: sourceThread.id,
        status: "error",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: "Different failure",
        updatedAt: "2026-10-01T00:00:00Z",
      };
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]!.text).toContain("Different failure");
      expect(
        (await loadState()).notifications.map((notification) => notification.occurrences),
      ).toEqual([2, 1]);
    });
  });
});

it("keeps completion receipts and error episodes separate for identical thread IDs on two hosts", async () => {
  for (const state of ["completed", "error"] as const)
    await withTempState(async () => {
      const saved = await loadState();
      await saveState({
        ...saved,
        environments: [
          ...saved.environments,
          makeEnvironment({ name: "other", environmentId: "env-2" }),
        ],
        agents: [...saved.agents, makeAgent({ name: "other-worker", environment: "other" })],
        subscriptions: [
          ...saved.subscriptions,
          makeSubscription({
            sourceEnvironment: "other",
            subscriberEnvironment: "other",
            sourceAgentName: "other-worker",
          }),
        ],
      });
      const sourceThread = makeThread();
      sourceThread.latestTurn!.state = state;
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread });
      await detectAttentionEvents({ clientFactory });
      await deliverPendingNotifications({ clientFactory });
      expect(sentMessages).toHaveLength(2);
      await detectAttentionEvents({ clientFactory });
      expect((await loadState()).notifications).toHaveLength(2);
      expect(new Set((await loadState()).notifications.map((n) => n.sourceEnvironment))).toEqual(
        new Set(["dev-vm", "other"]),
      );
    });
});

describe("child input reminders", () => {
  const start = Date.parse("2026-10-01T00:00:00Z");
  const waiting = () =>
    makeThread({
      parentThreadId: "thread-coordinator-a",
      activities: [
        {
          kind: "user-input.requested",
          createdAt: new Date(start).toISOString(),
          payload: {
            requestId: "question-1",
            questions: [
              {
                id: "direction",
                question: "Which gripper should I use?",
                options: [{ label: "Soft" }],
              },
            ],
          },
        },
      ],
    });
  it("reminds once after 20 minutes with the pending question and survives restart", async () => {
    await withTempState(async () => {
      const { clientFactory, sentMessages } = createClientFactory({ sourceThread: waiting() });
      let clock = start;
      const now = () => new Date(clock).toISOString();
      await detectAttentionEvents({ clientFactory, now });
      await deliverPendingNotifications({ clientFactory, now });
      expect(sentMessages[0]?.text).toContain("Which gripper should I use?");
      clock += 19 * 60_000;
      await detectAttentionEvents({ clientFactory, now });
      await deliverPendingNotifications({ clientFactory, now });
      expect(sentMessages).toHaveLength(1);
      clock += 60_000;
      await detectAttentionEvents({ clientFactory, now });
      await deliverPendingNotifications({ clientFactory, now });
      expect(sentMessages).toHaveLength(2);
      expect(sentMessages[1]?.text).toContain("Reminder");
      expect(sentMessages[1]?.text).toContain("Which gripper should I use?");
      expect(sentMessages[1]?.text).not.toContain("Thread communication quick start");
      await detectAttentionEvents({ clientFactory, now });
      await deliverPendingNotifications({ clientFactory, now });
      expect(sentMessages).toHaveLength(2);
      // New client/watcher, same persisted history.
      const restarted = createClientFactory({ sourceThread: waiting() });
      clock += 20 * 60_000;
      await detectAttentionEvents({ clientFactory: restarted.clientFactory, now });
      await deliverPendingNotifications({ clientFactory: restarted.clientFactory, now });
      expect(restarted.sentMessages).toHaveLength(0);
    });
  });
  it.each([0, 10])(
    "respects a configured %s-minute interval without suppressing initial input",
    async (minutes) => {
      await withTempState(async () => {
        const persisted = await loadState();
        await saveState({
          ...persisted,
          subscriptions: persisted.subscriptions.map((route) => ({
            ...route,
            level: "none",
            inputReminderMinutes: minutes,
          })),
        });
        const factory = createClientFactory({ sourceThread: waiting() });
        let clock = start;
        const now = () => new Date(clock).toISOString();
        await detectAttentionEvents({ clientFactory: factory.clientFactory, now });
        await deliverPendingNotifications({ clientFactory: factory.clientFactory, now });
        expect(factory.sentMessages).toHaveLength(1);
        clock += 10 * 60_000;
        await detectAttentionEvents({ clientFactory: factory.clientFactory, now });
        await deliverPendingNotifications({ clientFactory: factory.clientFactory, now });
        expect(factory.sentMessages).toHaveLength(minutes === 0 ? 1 : 2);
      });
    },
  );
  it.each(["answered", "settled", "archived", "unnested"])(
    "cancels an already detected reminder when the child is %s",
    async (change) => {
      await withTempState(async () => {
        let clock = start;
        const now = () => new Date(clock).toISOString();
        const first = createClientFactory({ sourceThread: waiting() });
        await detectAttentionEvents({ clientFactory: first.clientFactory, now });
        await deliverPendingNotifications({ clientFactory: first.clientFactory, now });
        clock += 20 * 60_000;
        await detectAttentionEvents({ clientFactory: first.clientFactory, now });
        const changed = waiting();
        if (change === "answered") changed.activities = [];
        if (change === "settled") changed.settledOverride = "settled";
        if (change === "archived") changed.archivedAt = now();
        if (change === "unnested") changed.parentThreadId = null;
        const next = createClientFactory({ sourceThread: changed });
        await deliverPendingNotifications({ clientFactory: next.clientFactory, now });
        expect(next.sentMessages).toEqual([]);
        expect((await loadState()).notifications.at(-1)?.status).toBe("superseded");
      });
    },
  );
});

describe("opt-in active-worker inactivity", () => {
  const at = (minute: number) =>
    new Date(Date.parse("2026-10-02T12:00:00Z") + minute * 60_000).toISOString();
  function runningThread() {
    return makeThread({
      messages: [],
      latestTurn: {
        turnId: "assigned-turn",
        state: "running",
        requestedAt: at(0),
        startedAt: at(0),
        completedAt: null,
        assistantMessageId: null,
      },
      session: {
        threadId: "thread-worker-a",
        status: "running",
        providerName: "codex",
        runtimeMode: "full-access",
        activeTurnId: "assigned-turn",
        lastError: null,
        updatedAt: at(0),
      },
    });
  }
  async function monitor(thread: OrchestrationThread, minutes = 15) {
    const state = await loadState();
    state.subscriptions[0]!.level = "attention";
    state.subscriptions[0]!.inactivityMinutes = minutes;
    await saveState(state);
    const transport = createClientFactory({ sourceThread: thread });
    async function scan(minute: number) {
      return detectAttentionEvents({
        clientFactory: transport.clientFactory,
        now: () => at(minute),
      });
    }
    return { ...transport, scan };
  }
  it("delivers one attention alert per silence episode across restart and rearms after tool progress", async () => {
    await withTempState(async () => {
      const thread = runningThread();
      const { scan, clientFactory, sentMessages } = await monitor(thread);
      for (let minute = 0; minute < 15; minute++) expect(await scan(minute)).toEqual([]);
      expect((await scan(15))[0]?.sourceState).toBe("inactive");
      await deliverPendingNotifications({ clientFactory, now: () => at(15) });
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]!.text).toContain(
        "No observable provider, tool, or reasoning progress for 15 minutes",
      );
      // A new detector loads the persisted observation and delivered episode.
      await detectAttentionEvents({
        clientFactory: createClientFactory({ sourceThread: thread }).clientFactory,
        now: () => at(16),
      });
      await deliverPendingNotifications({ clientFactory, now: () => at(16) });
      expect(sentMessages).toHaveLength(1);
      thread.activities.push({
        id: "tool-update",
        kind: "tool.progress",
        turnId: "assigned-turn",
        createdAt: at(17),
        payload: {},
      });
      for (let minute = 17; minute < 32; minute++) expect(await scan(minute)).toEqual([]);
      await scan(32);
      await deliverPendingNotifications({ clientFactory, now: () => at(32) });
      expect(sentMessages).toHaveLength(2);
      expect(
        (await loadState()).notifications.filter((n) => n.sourceState === "inactive"),
      ).toHaveLength(2);
    });
  });
  it.each([
    "tool.started",
    "tool.updated",
    "tool.progress",
    "tool.completed",
    "task.progress",
    "reasoning",
    "assistant",
  ])("counts current-turn %s evidence while prose is absent", async (kind) => {
    await withTempState(async () => {
      const thread = runningThread();
      const { scan } = await monitor(thread);
      for (let minute = 0; minute <= 20; minute++) {
        if (kind === "reasoning" || kind === "assistant")
          thread.messages = [
            {
              id: "stream",
              role: kind,
              text: "progress",
              turnId: "assigned-turn",
              streaming: true,
              createdAt: at(0),
              updatedAt: at(minute),
            },
          ];
        else
          thread.activities.push({
            id: `event-${minute}`,
            kind,
            turnId: "assigned-turn",
            createdAt: at(minute),
            payload: {},
          });
        expect(await scan(minute)).toEqual([]);
      }
    });
  });
  it.each([
    "completed",
    "idle",
    "archived",
    "settled",
    "input",
    "approval",
    "plan",
    "quota",
    "stopped",
    "disabled",
    "none",
  ])("does not flag %s workers and preserves required escalations", async (state) => {
    await withTempState(async () => {
      const thread = runningThread();
      if (state === "completed") thread.latestTurn!.state = "completed";
      if (state === "idle") {
        thread.latestTurn = null;
        thread.session = null;
      }
      if (state === "stopped") thread.session!.status = "stopped";
      if (state === "archived") thread.archivedAt = at(0);
      if (state === "settled") thread.settledOverride = "settled";
      if (["input", "approval"].includes(state))
        thread.activities.push({
          kind: state === "input" ? "user-input.requested" : "approval.requested",
          turnId: "assigned-turn",
          createdAt: at(0),
          payload: {
            requestId: "request-1",
            questions: [{ id: "q", question: "Which approach?", options: [] }],
          },
        });
      if (state === "plan")
        thread.proposedPlans.push({
          id: "plan",
          turnId: "assigned-turn",
          planMarkdown: "plan",
          implementedAt: null,
          createdAt: at(0),
          updatedAt: at(0),
        });
      if (state === "quota")
        thread.activities.push({
          kind: "runtime.warning",
          turnId: "assigned-turn",
          createdAt: at(0),
          payload: { detail: { rateLimitType: "session", status: "rejected" } },
        });
      const { scan } = await monitor(thread, state === "disabled" ? 0 : 15);
      if (state === "none") {
        const saved = await loadState();
        saved.subscriptions[0]!.level = "none";
        await saveState(saved);
      }
      for (let minute = 0; minute <= 20; minute++) {
        const events = await scan(minute);
        expect(events.some((n) => n.sourceState === "inactive")).toBe(false);
        if (["input", "approval", "plan"].includes(state)) expect(events).toHaveLength(1);
      }
    });
  });
  it("starts a new observation window after an outage instead of asserting a stall", async () => {
    await withTempState(async () => {
      const thread = runningThread();
      const { scan } = await monitor(thread);
      for (let minute = 0; minute <= 14; minute++) await scan(minute);
      await detectAttentionEvents({
        clientFactory: () => ({
          findThread: async () => {
            throw new Error("network unavailable");
          },
          sendMessage: async () => {},
        }),
        now: () => at(15),
      });
      expect((await loadState()).subscriptions[0]!.inactivityObservation).toBeNull();
      expect(await scan(30)).toEqual([]);
      for (let minute = 31; minute < 45; minute++) expect(await scan(minute)).toEqual([]);
      expect((await scan(45))[0]?.sourceState).toBe("inactive");
    });
  });
  it("keeps an opted-in watcher awake on unknown liveness without creating an alert", async () => {
    await withTempState(async () => {
      await monitor(runningThread());
      const state = await loadState();
      const clientFactory: WatchClientFactory = () => ({
        findThread: async () => {
          throw new Error("network unavailable");
        },
        sendMessage: async () => {},
      });
      expect(await hasActiveWork({ clientFactory })).toBe(true);
      expect(await scanAttentionNotifications(state, { clientFactory })).toEqual([]);
      state.subscriptions[0]!.inactivityMinutes = 0;
      await saveState(state);
      expect(await hasActiveWork({ clientFactory })).toBe(false);
    });
  });
  it("metadata, stale-turn activity and an open silent tool do not mask silence", async () => {
    await withTempState(async () => {
      const thread = runningThread();
      thread.activities.push({ kind: "tool.started", turnId: "assigned-turn", createdAt: at(0) });
      const { scan } = await monitor(thread);
      for (let minute = 0; minute <= 15; minute++) {
        thread.updatedAt = at(minute);
        thread.session!.updatedAt = at(minute);
        thread.activities.push(
          { kind: "tool.progress", turnId: "old-turn", createdAt: at(minute) },
          {
            kind: "runtime.warning",
            turnId: "assigned-turn",
            createdAt: at(minute),
            payload: { message: "poll" },
          },
        );
        const events = await scan(minute);
        expect(events).toHaveLength(minute === 15 ? 1 : 0);
      }
    });
  });
  it("new assignments rearm and long watcher pauses do not count as observed silence", async () => {
    await withTempState(async () => {
      const thread = runningThread();
      const { scan, clientFactory, sentMessages } = await monitor(thread);
      await scan(0);
      expect(await scan(10)).toEqual([]);
      for (let minute = 11; minute <= 25; minute++) await scan(minute);
      await deliverPendingNotifications({ clientFactory, now: () => at(25) });
      expect(sentMessages).toHaveLength(1);
      thread.latestTurn!.turnId = "next-assignment";
      thread.latestTurn!.startedAt = at(26);
      for (let minute = 26; minute <= 41; minute++) await scan(minute);
      await deliverPendingNotifications({ clientFactory, now: () => at(41) });
      expect(sentMessages).toHaveLength(2);
    });
  });
  it.each(["progress", "completed", "quota", "disabled", "network"])(
    "revalidates %s before delivering a delayed alert",
    async (change) => {
      await withTempState(async () => {
        const thread = runningThread();
        const { scan, clientFactory, sentMessages } = await monitor(thread);
        for (let minute = 0; minute <= 15; minute++) await scan(minute);
        if (change === "progress")
          thread.activities.push({
            kind: "tool.completed",
            turnId: "assigned-turn",
            createdAt: at(16),
          });
        if (change === "completed") thread.latestTurn!.state = "completed";
        if (change === "quota")
          thread.activities.push({
            kind: "runtime.warning",
            turnId: "assigned-turn",
            createdAt: at(16),
            payload: { detail: { rateLimitType: "session", status: "rejected" } },
          });
        if (change === "disabled") {
          const state = await loadState();
          state.subscriptions[0]!.inactivityMinutes = 0;
          await saveState(state);
        }
        const transport: WatchClientFactory =
          change === "network"
            ? () => ({
                findThread: async () => {
                  throw new Error("network unavailable");
                },
                sendMessage: async () => {
                  throw new Error("must not send");
                },
              })
            : clientFactory;
        await deliverPendingNotifications({ clientFactory: transport, now: () => at(16) });
        expect(sentMessages).toHaveLength(0);
        expect((await loadState()).notifications[0]?.status).toBe(
          change === "network" ? "delivery-failed" : "superseded",
        );
      });
    },
  );
});

describe("reliable handoff notification recovery", () => {
  it("steers a busy recipient and parks a dropped ack without autoretry", async () => {
    await withTempState(async () => {
      const subscriber = makeThread({
        id: "thread-coordinator-a",
        latestTurn: { ...makeThread().latestTurn!, state: "running" },
      });
      const factory = createClientFactory({ subscriberThread: subscriber });
      await detectAttentionEvents({ clientFactory: factory.clientFactory });
      let sends = 0;
      const clientFactory: WatchClientFactory = (environment) => ({
        ...factory.clientFactory(environment),
        supportsReliableHandoffs: async () => true,
        sendMessage: async (input) => {
          sends++;
          const claimed = (await loadState()).notifications[0]!;
          expect(claimed.sendId).toBe(input.commandId);
          return {
            dispatched: false,
            queued: false,
            uncertain: true,
            causeCode: "TRANSPORT_TIMEOUT",
            sendId: input.commandId,
          };
        },
      });
      const delivered = await deliverPendingNotifications({ clientFactory });
      expect(delivered[0]?.status).toBe("uncertain");
      expect(delivered[0]?.lastError).toBe("TRANSPORT_TIMEOUT");
      await deliverPendingNotifications({ clientFactory });
      expect(sends).toBe(1);
    });
  });
  it.each(["found", "unknown"] as const)(
    "resolves a stale claim as %s without another send",
    async (state) => {
      await withTempState(async () => {
        const factory = createClientFactory({});
        await detectAttentionEvents({ clientFactory: factory.clientFactory });
        const current = await loadState();
        current.notifications[0] = {
          ...current.notifications[0]!,
          sendId: "notification:fixture",
          status: "delivering",
          deliveryClaimPid: -1,
          lastAttemptedAt: "2020-01-01T00:00:00.000Z",
        };
        await saveState(current);
        let sends = 0,
          lookups = 0;
        const clientFactory: WatchClientFactory = (environment) => ({
          ...factory.clientFactory(environment),
          lookupSendReceipt: async (input) => {
            lookups++;
            expect(input).toEqual({ type: "exact", sendId: "notification:fixture" });
            return {
              state,
              retentionDays: 30,
              receipts:
                state === "unknown"
                  ? []
                  : [
                      {
                        sendId: "notification:fixture",
                        recipientThreadId: "thread-coordinator-a" as any,
                        status: "steered",
                        acceptedAt: "2026-10-07T00:00:00Z",
                        cause: null,
                        ownerThreadId: null,
                      },
                    ],
            };
          },
          sendMessage: async () => {
            sends++;
          },
        });
        const result = await deliverPendingNotifications({ clientFactory });
        expect(result[0]?.status).toBe(state === "found" ? "delivered" : "uncertain");
        expect(lookups).toBe(1);
        expect(sends).toBe(0);
      });
    },
  );
});

it("keeps derived attention settings and the successor recipient while the server still reports the retired parent", async () => {
  await withTempState(async () => {
    const state = await loadState();
    const worker = makeThread({ parentThreadId: "thread-coordinator-a" });
    const factory = createClientFactory({ sourceThread: worker });
    const route = {
      ...state.subscriptions[0]!,
      subscriberThreadId: "successor",
      nestingDerived: true,
      inputReminderMinutes: 7,
      inactivityMinutes: 17,
      lastSeenAssistantMessageId: "stable-baseline",
    };
    await saveState({
      ...state,
      subscriptions: [route],
      agents: state.agents.map((a) =>
        a.threadId === "thread-coordinator-a" ? { ...a, threadId: "successor" } : a,
      ),
      handoverRedirects: [
        {
          oldThreadId: "thread-coordinator-a",
          successorThreadId: "successor",
          targetEnvironment: "dev-vm",
          transferId: "handover",
        },
      ],
    });
    await detectAttentionEvents({
      clientFactory: (environment) => ({
        ...factory.clientFactory(environment),
        listThreads: async () => [
          {
            ...worker,
            latestUserMessageAt: null,
            hasPendingApprovals: false,
            hasPendingUserInput: false,
            hasActionableProposedPlan: false,
          },
        ],
      }),
    });
    const current = await loadState();
    expect(current.subscriptions).toHaveLength(1);
    expect(current.subscriptions[0]).toMatchObject({
      subscriberThreadId: "successor",
      nestingDerived: true,
      inputReminderMinutes: 7,
      inactivityMinutes: 17,
    });
    expect(current.subscriptions.some((r) => r.subscriberThreadId === "thread-coordinator-a")).toBe(
      false,
    );
  });
});
