import { describe, expect, it } from "vitest";

import {
  buildNotificationEventKey,
  buildNotificationMessage,
  buildNotificationRecord,
} from "../src/notifications.js";
import type {
  OrchestrationThread,
  SavedAgent,
  SavedSubscription,
} from "../src/types.js";

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
  it("builds a stable event key from subscriber, source, and assistant message", () => {
    expect(
      buildNotificationEventKey({
        subscriberThreadId: "thread-coordinator-a",
        sourceThreadId: "thread-worker-a",
        latestAssistantMessageId: "assistant-1",
        latestTurnId: "turn-1",
        sourceState: "completed",
      }),
    ).toBe("thread-coordinator-a:thread-worker-a:assistant:assistant-1");
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
    ).toBe("thread-coordinator-a:thread-worker-a:turn:turn-1:error");
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

    expect(message).toContain("worker-a needs attention");
    expect(message).toContain("State: completed.");
    expect(message).toContain("Reason: latest turn completed.");
  });
});
