import { describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import type {
  OrchestrationProposedPlan,
  OrchestrationThread,
  SavedEnvironment,
} from "../src/types.js";

function makePlan(overrides: Partial<OrchestrationProposedPlan> = {}): OrchestrationProposedPlan {
  return {
    id: "plan-1",
    turnId: "turn-1",
    planMarkdown: "# Add feature\n\n1. edit\n2. test\n",
    implementedAt: null,
    implementationThreadId: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Plan worker",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "plan",
    branch: "t3/plan-worker",
    worktreePath: "/tmp/plan-worker",
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-07-11T00:00:00.000Z",
      startedAt: "2026-07-11T00:00:01.000Z",
      completedAt: "2026-07-11T00:00:02.000Z",
      assistantMessageId: "assistant-1",
    },
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:02.000Z",
    archivedAt: null,
    messages: [],
    proposedPlans: [makePlan()],
    activities: [],
    checkpoints: [],
    session: null,
    ...overrides,
  };
}

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

function makeHarness(thread: OrchestrationThread) {
  const commands: Array<Record<string, unknown>> = [];
  const dispose = vi.fn(async () => undefined);
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
    dispose,
  };
  const client = new RemoteEnvironmentClient(environment, { rpcFactory: () => rpc });
  return { client, commands, dispose };
}

describe("RemoteEnvironmentClient.implementPlan", () => {
  it("dispatches the same-thread Plan Ready implementation sequence", async () => {
    const harness = makeHarness(makeThread());

    const result = await harness.client.implementPlan({ threadId: "thread-1" });

    expect(harness.commands).toHaveLength(2);
    expect(harness.commands[0]).toMatchObject({
      type: "thread.interaction-mode.set",
      threadId: "thread-1",
      interactionMode: "default",
    });
    expect(harness.commands[1]).toMatchObject({
      type: "thread.turn.start",
      threadId: "thread-1",
      message: {
        role: "user",
        text: "PLEASE IMPLEMENT THIS PLAN:\n# Add feature\n\n1. edit\n2. test",
        attachments: [],
      },
      modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
      titleSeed: "Plan worker",
      runtimeMode: "full-access",
      interactionMode: "default",
      sourceProposedPlan: { threadId: "thread-1", planId: "plan-1" },
    });
    expect(harness.commands[1]).not.toHaveProperty("bootstrap");
    expect(result).toEqual({ threadId: "thread-1", planId: "plan-1", modeChanged: true });
    expect(harness.dispose).toHaveBeenCalledOnce();
  });

  it("does not dispatch a redundant mode change when the thread is already in build mode", async () => {
    const harness = makeHarness(makeThread({ interactionMode: "default" }));

    const result = await harness.client.implementPlan({ threadId: "thread-1" });

    expect(harness.commands).toHaveLength(1);
    expect(harness.commands[0]?.type).toBe("thread.turn.start");
    expect(result.modeChanged).toBe(false);
  });

  it("selects the latest plan for the latest turn and supports an explicit plan id", async () => {
    const older = makePlan({
      id: "plan-old",
      turnId: "turn-old",
      updatedAt: "2026-07-11T00:00:03.000Z",
    });
    const current = makePlan({
      id: "plan-current",
      updatedAt: "2026-07-11T00:00:02.000Z",
    });
    const automaticHarness = makeHarness(makeThread({ proposedPlans: [older, current] }));

    const automaticResult = await automaticHarness.client.implementPlan({ threadId: "thread-1" });

    expect(automaticResult.planId).toBe("plan-current");
    expect(automaticHarness.commands.at(-1)).toMatchObject({
      sourceProposedPlan: { planId: "plan-current" },
    });

    const harness = makeHarness(makeThread({ proposedPlans: [older, current] }));

    const result = await harness.client.implementPlan({
      threadId: "thread-1",
      planId: "plan-old",
    });

    expect(result.planId).toBe("plan-old");
    expect(harness.commands.at(-1)).toMatchObject({
      sourceProposedPlan: { planId: "plan-old" },
    });
  });

  it("reports a partial failure when mode changes but the turn cannot start", async () => {
    const thread = makeThread();
    const commands: Array<Record<string, unknown>> = [];
    const rpc = {
      subscribeThreadSnapshot: vi.fn(async () => ({
        kind: "snapshot",
        snapshot: { snapshotSequence: 1, thread },
      })),
      subscribeShellSnapshot: vi.fn(),
      request: vi.fn(async (_method: string, input: unknown) => {
        commands.push(input as Record<string, unknown>);
        if (commands.length === 2) throw new Error("provider unavailable");
        return { sequence: commands.length };
      }),
      dispose: vi.fn(async () => undefined),
    };
    const client = new RemoteEnvironmentClient(environment, { rpcFactory: () => rpc });

    await expect(client.implementPlan({ threadId: "thread-1" })).rejects.toThrow(
      "was switched to default mode, but the implementation turn failed to start: provider unavailable",
    );
    expect(commands.map((command) => command.type)).toEqual([
      "thread.interaction-mode.set",
      "thread.turn.start",
    ]);
  });

  it("does not silently implement an older plan when the current plan is already implemented", async () => {
    const older = makePlan({
      id: "plan-old",
      turnId: "turn-old",
      implementedAt: null,
    });
    const current = makePlan({
      id: "plan-current",
      implementedAt: "2026-07-11T00:01:00.000Z",
      implementationThreadId: "thread-1",
    });
    const automaticHarness = makeHarness(makeThread({ proposedPlans: [older, current] }));

    await expect(automaticHarness.client.implementPlan({ threadId: "thread-1" })).rejects.toThrow(
      "Proposed plan 'plan-current' is already implemented.",
    );
    expect(automaticHarness.commands).toEqual([]);

    const explicitHarness = makeHarness(makeThread({ proposedPlans: [older, current] }));
    const result = await explicitHarness.client.implementPlan({
      threadId: "thread-1",
      planId: "plan-old",
    });
    expect(result.planId).toBe("plan-old");
  });

  it.each([
    ["has no proposed plan", makeThread({ proposedPlans: [] }), "has no proposed plan"],
    [
      "has an already implemented plan",
      makeThread({
        proposedPlans: [
          makePlan({
            implementedAt: "2026-07-11T00:01:00.000Z",
            implementationThreadId: "thread-1",
          }),
        ],
      }),
      "already implemented",
    ],
    [
      "is running",
      makeThread({
        session: {
          threadId: "provider-thread-1",
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: "turn-active",
          lastError: null,
          updatedAt: "2026-07-11T00:01:00.000Z",
        },
      }),
      "is still running",
    ],
    ["is archived", makeThread({ archivedAt: "2026-07-11T00:01:00.000Z" }), "is archived"],
  ])("rejects before dispatch when the thread %s", async (_label, thread, message) => {
    const harness = makeHarness(thread);

    await expect(harness.client.implementPlan({ threadId: "thread-1" })).rejects.toThrow(message);
    expect(harness.commands).toEqual([]);
  });
});
