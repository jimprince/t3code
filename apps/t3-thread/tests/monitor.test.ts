import { describe, expect, it } from "vite-plus/test";

import {
  buildAgentOverview,
  getLatestAssistantMessage,
  getLatestTurnAssistantMessage,
  needsAttention,
  summarizeMessageText,
} from "../src/monitor.js";
import type { OrchestrationThread, SavedAgent } from "../src/types.js";

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Test thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-15T00:00:00.000Z",
    updatedAt: "2026-04-15T00:00:00.000Z",
    archivedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

function makeAgent(overrides: Partial<SavedAgent> = {}): SavedAgent {
  return {
    name: "worker-a",
    environment: "dev-vm",
    threadId: "thread-1",
    projectId: "project-1",
    title: "Worker A",
    createdAt: "2026-04-15T00:00:00.000Z",
    lastSeenAssistantMessageId: null,
    ...overrides,
  };
}

describe("monitor helpers", () => {
  it("finds the latest assistant message", () => {
    const thread = makeThread({
      messages: [
        {
          id: "user-1",
          role: "user",
          text: "hello",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
        {
          id: "assistant-1",
          role: "assistant",
          text: "first",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-04-15T00:00:01.000Z",
          updatedAt: "2026-04-15T00:00:01.000Z",
        },
        {
          id: "assistant-2",
          role: "assistant",
          text: "second",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:02.000Z",
          updatedAt: "2026-04-15T00:00:02.000Z",
        },
      ],
    });

    expect(getLatestAssistantMessage(thread)?.id).toBe("assistant-2");
  });

  it("finds the final assistant message for the latest turn by assistantMessageId", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-2",
        state: "completed",
        requestedAt: "2026-04-15T00:00:00.000Z",
        startedAt: "2026-04-15T00:00:01.000Z",
        completedAt: "2026-04-15T00:00:02.000Z",
        assistantMessageId: "assistant-2-final",
      },
      messages: [
        {
          id: "assistant-2-progress",
          role: "assistant",
          text: "Still working",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:01.500Z",
          updatedAt: "2026-04-15T00:00:01.500Z",
        },
        {
          id: "assistant-2-final",
          role: "assistant",
          text: "Done",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:02.000Z",
          updatedAt: "2026-04-15T00:00:02.000Z",
        },
      ],
    });

    expect(getLatestTurnAssistantMessage(thread)?.id).toBe("assistant-2-final");
  });

  it("prefers the last same-turn assistant message over a stale pinned assistantMessageId", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-2",
        state: "completed",
        requestedAt: "2026-04-15T00:00:00.000Z",
        startedAt: "2026-04-15T00:00:01.000Z",
        completedAt: "2026-04-15T00:00:02.000Z",
        // Pinned id points at an EARLY progress/setup message. The CLI
        // previously trusted this pointer verbatim and returned stale text.
        assistantMessageId: "assistant-2-setup",
      },
      messages: [
        {
          id: "assistant-2-setup",
          role: "assistant",
          text: "Spinning up the worker",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:01.100Z",
          updatedAt: "2026-04-15T00:00:01.100Z",
        },
        {
          id: "assistant-2-progress",
          role: "assistant",
          text: "Still running tools",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:01.500Z",
          updatedAt: "2026-04-15T00:00:01.500Z",
        },
        {
          id: "assistant-2-final",
          role: "assistant",
          text: "Final report for the caller",
          turnId: "turn-2",
          streaming: false,
          createdAt: "2026-04-15T00:00:02.000Z",
          updatedAt: "2026-04-15T00:00:02.000Z",
        },
      ],
    });

    const resolved = getLatestTurnAssistantMessage(thread);
    expect(resolved?.id).toBe(
      "assistant-2-final",
    );
    expect(resolved?.text).toBe("Final report for the caller");
    expect(resolved?.id).not.toBe(
      "assistant-2-setup",
    );
    // REGRESSION: Socrates overseer probes on 2026-04-21 showed the CLI
    // returning an early setup/progress message because the old resolver
    // trusted latestTurn.assistantMessageId as the terminal pointer. The
    // resolver must scan for the LAST assistant message whose turnId matches
    // latestTurn.turnId so the final report wins over the stale pinned id.
  });

  it("falls back to the pinned assistantMessageId when no same-turn assistant message exists", () => {
    const thread = makeThread({
      latestTurn: {
        turnId: "turn-3",
        state: "completed",
        requestedAt: "2026-04-15T00:00:00.000Z",
        startedAt: "2026-04-15T00:00:01.000Z",
        completedAt: "2026-04-15T00:00:02.000Z",
        assistantMessageId: "assistant-cross-turn",
      },
      messages: [
        {
          id: "assistant-cross-turn",
          role: "assistant",
          text: "Historical answer from a prior turn",
          turnId: "turn-1",
          streaming: false,
          createdAt: "2026-04-15T00:00:00.500Z",
          updatedAt: "2026-04-15T00:00:00.500Z",
        },
      ],
    });

    expect(getLatestTurnAssistantMessage(thread)?.id).toBe(
      "assistant-cross-turn",
    );
  });

  it("returns null when there is no latestTurn and no assistantMessageId", () => {
    const thread = makeThread({
      latestTurn: null,
      messages: [
        {
          id: "assistant-orphan",
          role: "assistant",
          text: "Orphan message",
          turnId: null,
          streaming: false,
          createdAt: "2026-04-15T00:00:00.000Z",
          updatedAt: "2026-04-15T00:00:00.000Z",
        },
      ],
    });

    expect(getLatestTurnAssistantMessage(thread)).toBeNull();
  });

  it("marks new assistant output when the latest assistant message is unseen", () => {
    const overview = buildAgentOverview(
      makeAgent({ lastSeenAssistantMessageId: "assistant-1" }),
      makeThread({
        latestTurn: {
          turnId: "turn-2",
          state: "completed",
          requestedAt: "2026-04-15T00:00:00.000Z",
          startedAt: "2026-04-15T00:00:01.000Z",
          completedAt: "2026-04-15T00:00:02.000Z",
          assistantMessageId: "assistant-2",
        },
        messages: [
          {
            id: "assistant-2",
            role: "assistant",
            text: "Fresh output from the remote worker",
            turnId: "turn-2",
            streaming: false,
            createdAt: "2026-04-15T00:00:02.000Z",
            updatedAt: "2026-04-15T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(overview.hasNewOutput).toBe(true);
    expect(needsAttention(overview)).toBe(true);
  });

  it("does not mark completed work as attention-worthy after it has been acknowledged", () => {
    const overview = buildAgentOverview(
      makeAgent({ lastSeenAssistantMessageId: "assistant-2" }),
      makeThread({
        latestTurn: {
          turnId: "turn-2",
          state: "completed",
          requestedAt: "2026-04-15T00:00:00.000Z",
          startedAt: "2026-04-15T00:00:01.000Z",
          completedAt: "2026-04-15T00:00:02.000Z",
          assistantMessageId: "assistant-2",
        },
        messages: [
          {
            id: "assistant-2",
            role: "assistant",
            text: "Already reviewed",
            turnId: "turn-2",
            streaming: false,
            createdAt: "2026-04-15T00:00:02.000Z",
            updatedAt: "2026-04-15T00:00:02.000Z",
          },
        ],
      }),
    );

    expect(overview.hasNewOutput).toBe(false);
    expect(needsAttention(overview)).toBe(false);
  });

  it("normalizes whitespace and truncates previews", () => {
    expect(summarizeMessageText("line one\n\nline two", 12)).toBe("line one...");
  });
});
