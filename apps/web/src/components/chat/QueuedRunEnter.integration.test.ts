import { promoteQueuedRunOnce } from "../../queuedRunPromotion";
import { describe, expect, it } from "vite-plus/test";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import { sendQueuedRunOnEmptyEnter } from "../../queuedRunEnter";

describe("empty composer with native queued runs", () => {
  it("uses native order/capabilities and sends only once while promotion is pending", async () => {
    const workflow = deriveThreadQueueWorkflowState({
      thread: { id: "thread", activeProviderThreadId: "provider" },
      runs: [
        {
          id: "active",
          status: "running",
          activeAttemptId: "attempt",
          providerThreadId: "provider",
          ordinal: 1,
        },
        { id: "second", status: "queued", userMessageId: "b", ordinal: 3 },
        { id: "first", status: "queued", userMessageId: "a", ordinal: 2 },
      ],
      messages: [],
      providerTurns: [{ runAttemptId: "attempt", status: "running" }],
      providerThreads: [{ id: "provider", providerSessionId: "session" }],
      providerSessions: [
        {
          id: "session",
          status: "running",
          capabilities: { turns: { supportsQueuedMessages: true, supportsActiveSteering: true } },
        },
      ],
    } as never);
    expect(workflow.queuedRuns[0]?.run.id).toBe("first");
    expect(workflow.canPromoteToSteer).toBe(true);
    const promoted: string[] = [];
    const inFlight = { current: false };
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const control = {
      steerNext(repeat: boolean) {
        const next = workflow.queuedRuns[0];
        if (!next || !workflow.canPromoteToSteer) return false;
        if (!repeat)
          void promoteQueuedRunOnce({
            queuedRunId: next.run.id,
            targetRunId: workflow.activeRun?.id ?? null,
            canPromote: workflow.canPromoteToSteer,
            inFlight,
            busy: () => {},
            promote: async (input) => {
              promoted.push(input.queuedRunId);
              await pending;
            },
          });
        return true;
      },
    };
    const empty = { hasSendableContent: false, expiredTerminalContextCount: 0 };
    expect(sendQueuedRunOnEmptyEnter({ ...empty, hasSendableContent: true }, control)).toBe(false);
    expect(sendQueuedRunOnEmptyEnter({ ...empty, expiredTerminalContextCount: 1 }, control)).toBe(
      false,
    );
    sendQueuedRunOnEmptyEnter(empty, control);
    sendQueuedRunOnEmptyEnter(empty, control);
    sendQueuedRunOnEmptyEnter({ ...empty, repeat: true }, control);
    expect(promoted).toEqual(["first"]);
    finish();
    await pending;
    expect(sendQueuedRunOnEmptyEnter(empty, null)).toBe(false);
  });
});
