import { describe, expect, it } from "vitest";

import { buildFollowUpMessage } from "../src/agentPrompts.js";
import { classifyThread } from "../src/status.js";
import type { OrchestrationThread, OrchestrationThreadShell } from "../src/types.js";

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

function makeThreadShell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: "thread-shell-1",
    projectId: "project-1",
    title: "Shell thread",
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
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("classifyThread", () => {
  it("marks unimplemented plans as actionable", () => {
    const status = classifyThread(
      makeThread({
        proposedPlans: [
          {
            id: "plan-1",
            turnId: null,
            planMarkdown: "Do the thing",
            implementedAt: null,
            createdAt: "2026-04-15T00:00:00.000Z",
            updatedAt: "2026-04-15T00:00:00.000Z",
          },
        ],
      }),
    );

    expect(status.state).toBe("needs-plan");
  });

  it("reports running when the latest turn is active", () => {
    const status = classifyThread(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "running",
          requestedAt: "2026-04-15T00:00:00.000Z",
          startedAt: "2026-04-15T00:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    );

    expect(status.state).toBe("running");
  });

  it("reports running when session is still active despite a completed turn (regression)", () => {
    // REGRESSION: 2026-04-22 reprobe showed T3 sets latestTurn.state=completed
    // with an early `completedAt` while session.status is still `running` and
    // session.activeTurnId is still set, and more assistant messages continue
    // to arrive in the SAME turn. Classifier must trust session metadata over
    // the early completion flag so `--wait` and `agent status` do not report
    // `completed` prematurely.
    const status = classifyThread(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: "2026-04-22T17:14:35.000Z",
          startedAt: "2026-04-22T17:14:35.500Z",
          completedAt: "2026-04-22T17:14:51.462Z",
          assistantMessageId: "assistant-loading",
        },
        session: {
          threadId: "thread-1",
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-04-22T17:14:51.500Z",
        },
      }),
    );

    expect(status.state).toBe(
      "running",
    );
  });

  it("reports running when session has an active turn even if session.status is not 'running'", () => {
    // REGRESSION: guard the activeTurnId branch explicitly so a session with
    // status "starting"/"ready" but a still-present activeTurnId is not
    // classified as completed.
    const status = classifyThread(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: "2026-04-22T17:14:35.000Z",
          startedAt: "2026-04-22T17:14:35.500Z",
          completedAt: "2026-04-22T17:14:51.462Z",
          assistantMessageId: "assistant-loading",
        },
        session: {
          threadId: "thread-1",
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-1",
          lastError: null,
          updatedAt: "2026-04-22T17:14:51.500Z",
        },
      }),
    );

    expect(status.state).toBe("running");
  });

  it("still reports completed once the session has no active turn", () => {
    const status = classifyThread(
      makeThread({
        latestTurn: {
          turnId: "turn-1",
          state: "completed",
          requestedAt: "2026-04-22T17:14:35.000Z",
          startedAt: "2026-04-22T17:14:35.500Z",
          completedAt: "2026-04-22T17:15:51.001Z",
          assistantMessageId: "assistant-final",
        },
        session: {
          threadId: "thread-1",
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: "2026-04-22T17:15:51.100Z",
        },
      }),
    );

    expect(status.state).toBe("completed");
  });

  it("reports pending approval from a shell snapshot", () => {
    const status = classifyThread(
      makeThreadShell({
        hasPendingApprovals: true,
      }),
    );

    expect(status.state).toBe("needs-approval");
  });
});

describe("buildFollowUpMessage", () => {
  it("builds a revision request prefix", () => {
    expect(buildFollowUpMessage("revise", "Avoid the generated file")).toBe(
      "Revision request: Avoid the generated file",
    );
  });

  it("provides a default completion prompt", () => {
    expect(buildFollowUpMessage("complete")).toContain("Completion request:");
  });
});
