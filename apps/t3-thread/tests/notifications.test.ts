import { describe, expect, it } from "vite-plus/test";

import {
  buildNotificationEventKey,
  buildNotificationMessage,
  buildNotificationRecord,
} from "../src/notifications.js";
import { withSenderHeader } from "../src/thread-identity.js";
import type { OrchestrationThread, SavedAgent, SavedSubscription } from "../src/types.js";

function makeAgent(overrides: Partial<SavedAgent> = {}): SavedAgent {
  return {
    name: "worker-a",
    environment: "local-mbp",
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
    subscriberEnvironment: "local-mbp",
    sourceThreadId: "thread-worker-a",
    sourceAgentName: "worker-a",
    sourceEnvironment: "local-mbp",
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
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

describe("notification helpers", () => {
  it("keeps subscription controls out of direct thread sends and queued replays", () => {
    const origin = {
      source: "thread-send" as const,
      fromThreadId: "thread-worker-a",
      fromName: "worker-a",
    };
    const message = withSenderHeader("Please review the result.", origin, "local-mbp");
    expect(message).toContain('reply: "t3-thread send worker-a ..."');
    expect(message).toContain("Please review the result.");
    expect(message).not.toContain("Notifications:");
    expect(withSenderHeader(message, origin, "local-mbp")).toBe(message);
  });

  it("builds a stable event key from subscriber, source, and assistant message", () => {
    expect(
      buildNotificationEventKey({
        subscriberThreadId: "thread-coordinator-a",
        sourceThreadId: "thread-worker-a",
        latestAssistantMessageId: "assistant-1",
        latestTurnId: "turn-1",
        sourceState: "completed",
      }),
    ).toBe("thread-coordinator-a:thread-worker-a:turn-1:completed:assistant:assistant-1");
  });

  it("falls back to turn and state when no assistant message exists", () => {
    expect(
      buildNotificationEventKey({
        subscriberThreadId: "thread-coordinator-a",
        sourceThreadId: "thread-worker-a",
        latestAssistantMessageId: null,
        latestTurnId: "turn-1",
        sourceState: "error",
      }),
    ).toBe("thread-coordinator-a:thread-worker-a:turn-1:error:turn:turn-1:error");
  });

  it("builds a pending notification record from overview and subscription data", () => {
    const notification = buildNotificationRecord({
      sourceAgent: makeAgent(),
      subscription: makeSubscription(),
      overview: {
        name: "worker-a",
        environment: "local-mbp",
        threadId: "thread-worker-a",
        title: "Worker A",
        state: "completed",
        reason: "latest turn completed",
        hasNewOutput: true,
        latestAssistantMessageId: "assistant-1",
        latestAssistantPreview: "Worker finished the task",
      },
      thread: makeThread(),
      now: "2026-04-17T01:00:00.000Z",
    });

    expect(notification.status).toBe("pending");
    expect(notification.sourceAgentName).toBe("worker-a");
    expect(notification.subscriberAgentName).toBe("coordinator-a");
    expect(notification.preview).toBe("Worker finished the task");
  });

  it("formats a readable routed notification message", () => {
    const message = buildNotificationMessage(
      buildNotificationRecord({
        sourceAgent: makeAgent(),
        subscription: makeSubscription(),
        overview: {
          name: "worker-a",
          environment: "local-mbp",
          threadId: "thread-worker-a",
          title: "Worker A",
          state: "completed",
          reason: "latest turn completed",
          hasNewOutput: true,
          latestAssistantMessageId: "assistant-1",
          latestAssistantPreview: "Worker finished the task and has output ready for review.",
        },
        thread: makeThread(),
        now: "2026-04-17T01:00:00.000Z",
      }),
    );

    expect(message).toContain("worker-a completed a turn");
    expect(message).toContain("State: completed.");
    expect(message).toContain("Reason: latest turn completed.");
    expect(message).toContain(
      "Decide whether worker-a is finished: if so, settle it with `t3-thread settle worker-a`",
    );
  });

  it.each(["worker-a", null])(
    "ends every optional notice with one controls line (name: %s)",
    (name) => {
      const notification = buildNotificationRecord({
        sourceAgent: makeAgent(),
        subscription: makeSubscription({ sourceAgentName: name }),
        overview: {
          name: "worker-a",
          environment: "local-mbp",
          threadId: "thread-worker-a",
          title: "Worker A",
          state: "completed",
          reason: "latest turn completed",
          hasNewOutput: true,
          latestAssistantMessageId: "assistant-1",
          latestAssistantPreview: null,
        },
        thread: makeThread(),
        now: "2026-04-17T01:00:00.000Z",
      });
      for (const includeOnboarding of [false, true]) {
        const message = buildNotificationMessage(notification, includeOnboarding);
        const lines = message.split("\n");
        expect(lines.at(-1)).toBe(
          "Notifications: t3-thread agent subscribe --watch thread-worker-a --level attention|none · stop: t3-thread agent unsubscribe --watch thread-worker-a",
        );
        expect(lines.filter((line) => line.startsWith("Notifications:"))).toHaveLength(1);
        expect(lines).toHaveLength(includeOnboarding ? 3 : 2);
        const childMessage = buildNotificationMessage(
          { ...notification, isChildInput: true },
          includeOnboarding,
        );
        expect(childMessage).toContain("You are responsible for this child's pending request");
        expect(childMessage).not.toContain("Notifications:");
        expect(childMessage).not.toContain("agent subscribe");
        expect(childMessage).not.toContain("agent unsubscribe");
      }
    },
  );

  it("asks for a settlement decision only when the source completed", () => {
    const message = buildNotificationMessage(
      buildNotificationRecord({
        sourceAgent: makeAgent(),
        subscription: makeSubscription(),
        overview: {
          name: "worker-a",
          environment: "local-mbp",
          threadId: "thread-worker-a",
          title: "Worker A",
          state: "needs-approval",
          reason: "approval request is pending",
          hasNewOutput: false,
          latestAssistantMessageId: null,
          latestAssistantPreview: null,
        },
        thread: makeThread(),
        now: "2026-04-17T01:00:00.000Z",
      }),
    );

    expect(message).toContain("State: needs-approval.");
    expect(message).not.toContain("t3-thread settle");
  });
});
