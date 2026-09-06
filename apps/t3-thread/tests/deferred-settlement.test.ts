import { describe, expect, it, vi } from "vite-plus/test";
import { settleAfterTurn } from "../src/deferredSettlement.js";
import type { OrchestrationThread } from "../src/types.js";

const request = { threadId: "thread-1", environment: "test", turnId: "turn-1", unsettledAt: null };
const timestamp = "2026-09-09T12:00:00Z";
function thread(overrides: Partial<OrchestrationThread> = {}): OrchestrationThread {
  return {
    id: request.threadId,
    projectId: "project",
    title: "Self",
    modelSelection: { provider: "codex", model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    session: null,
    latestTurn: {
      turnId: request.turnId,
      state: "completed",
      requestedAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      assistantMessageId: "reply",
    },
    messages: [
      {
        id: "reply",
        role: "assistant",
        turnId: request.turnId,
        text: "Done",
        streaming: false,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  };
}

function harness(snapshots: Array<OrchestrationThread | Error>) {
  let time = 0;
  const findThread = vi.fn(async () => {
    const next = snapshots.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("offline");
    return next;
  });
  const settleThread = vi.fn(async () => ({ settledOverride: "settled", settledAt: timestamp }));
  const wait = vi.fn(async () => {
    time += 1;
  });
  return { client: { findThread, settleThread }, options: { now: () => time, wait, timeoutMs: 5 } };
}

describe("deferred self settlement", () => {
  it("waits for the same turn's persisted final response and a quiet session", async () => {
    const done = thread();
    const h = harness([
      thread({ latestTurn: { ...done.latestTurn!, state: "running", completedAt: null } }),
      thread({ messages: [{ ...done.messages[0]!, streaming: true }] }),
      thread({ messages: [] }),
      thread({
        session: {
          threadId: request.threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: request.turnId,
          lastError: null,
          updatedAt: timestamp,
        },
      }),
      done,
    ]);
    await expect(settleAfterTurn(request, h.client, h.options)).resolves.toMatchObject({
      settled: true,
      result: { settledOverride: "settled" },
    });
    expect(h.options.wait).toHaveBeenCalledTimes(4);
    expect(h.client.settleThread).toHaveBeenCalledExactlyOnceWith(request.threadId, { self: true });
  });

  it.each([
    thread({ latestTurn: { ...thread().latestTurn!, turnId: "new-turn" } }),
    thread({ unsettledAt: timestamp }),
    thread({ archivedAt: timestamp }),
    thread({ deletedAt: timestamp }),
    thread({ latestTurn: { ...thread().latestTurn!, state: "error" } }),
    thread({ latestTurn: { ...thread().latestTurn!, state: "interrupted" } }),
    thread({
      proposedPlans: [
        {
          id: "plan",
          turnId: request.turnId,
          planMarkdown: "Approval needed",
          implementedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    }),
  ])("cancels superseded or attention-needed work", async (snapshot) => {
    const h = harness([snapshot]);
    await expect(settleAfterTurn(request, h.client, h.options)).resolves.toMatchObject({
      cancelled: true,
    });
    expect(h.client.settleThread).not.toHaveBeenCalled();
  });

  it("rechecks thread identity after a transport failure or raced server guard", async () => {
    const h = harness([
      new Error("fetch failed"),
      thread(),
      thread({ latestTurn: { ...thread().latestTurn!, turnId: "next" } }),
    ]);
    h.client.settleThread.mockRejectedValueOnce(new Error("This thread still needs attention."));
    await expect(settleAfterTurn(request, h.client, h.options)).resolves.toMatchObject({
      cancelled: true,
    });
    expect(h.client.settleThread).toHaveBeenCalledOnce();
  });

  it("honors local cancellation even when remote unsettle leaves its timestamp unchanged", async () => {
    const h = harness([thread()]);
    const isCancelled = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await expect(
      settleAfterTurn(request, h.client, { ...h.options, isCancelled }),
    ).resolves.toMatchObject({ cancelled: true });
    expect(h.client.settleThread).not.toHaveBeenCalled();
  });

  it("expires instead of settling when completion never arrives", async () => {
    const h = harness([]);
    await expect(settleAfterTurn(request, h.client, h.options)).rejects.toThrow(
      "Deferred settlement expired",
    );
    expect(h.client.settleThread).not.toHaveBeenCalled();
  });
});
