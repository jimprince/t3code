import { describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import type { OrchestrationThread, SavedEnvironment } from "../src/types.js";

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

function makeRunningThread(): OrchestrationThread {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Worker",
    modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "t3/worker",
    worktreePath: "/tmp/worker",
    latestTurn: {
      turnId: "turn-1",
      state: "running",
      requestedAt: "2026-09-04T00:00:00.000Z",
      startedAt: "2026-09-04T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:01.000Z",
    archivedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: { status: "running", activeTurnId: "turn-1", lastError: null },
  } as unknown as OrchestrationThread;
}

function makeHarness(thread: OrchestrationThread) {
  const commands: Array<Record<string, unknown>> = [];
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
    dispose: vi.fn(async () => undefined),
  };
  return {
    client: new RemoteEnvironmentClient(environment, { rpcFactory: () => rpc }),
    commands,
  };
}

describe("RemoteEnvironmentClient.sendMessage while a turn is running", () => {
  it("rejects the send instead of dispatching a concurrent turn", async () => {
    const harness = makeHarness(makeRunningThread());

    await expect(
      harness.client.sendMessage({ threadId: "thread-1", text: "status?" }),
    ).rejects.toThrow(/is still running/);
    expect(harness.commands).toHaveLength(0);
  });

  // Desired behaviour, not yet implemented. `t3-thread send` is the only way an
  // overseer can reach a worker mid-run, and today it fails outright: the
  // overseer must either interrupt the worker (losing the turn) or busy-wait
  // for the turn to end. Neither is acceptable for routine supervision, so a
  // send to a running thread should be accepted and held, then dispatched as a
  // single follow-up turn at the next turn boundary — with `send` reporting
  // that the message was queued rather than dispatched, so the caller is not
  // misled into thinking the worker already saw it.
  //
  // Deliberately not implemented here: the queue needs a durable home (the
  // server, not the CLI process, which exits immediately after `send`) and a
  // decision about ordering and coalescing when several sends land during one
  // turn. Tracked as follow-up work.
  it.skip("queues the message and dispatches it at the next turn boundary", async () => {
    const harness = makeHarness(makeRunningThread());

    const result = await harness.client.sendMessage({ threadId: "thread-1", text: "status?" });

    expect(result).toMatchObject({ queued: true });
    expect(harness.commands).toHaveLength(0);
  });
});
