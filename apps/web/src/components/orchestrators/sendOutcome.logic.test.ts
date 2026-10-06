import type { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { failureReason, sendRequest, type SendHandle, type SendOutcome } from "./sendOutcome.logic";

const intakeThread = { threadId: "intake-1" as ThreadId };
const started = { _tag: "Success" as const, value: intakeThread };

const handle = (outcome: SendOutcome, queued = false): SendHandle => ({
  messageId: "m1" as MessageId,
  queued,
  done: Promise.resolve(outcome),
});

describe("failureReason", () => {
  it("reads the message of an error or an error-shaped value", () => {
    expect(failureReason(new Error("socket closed"))).toBe("socket closed");
    expect(failureReason({ message: "image too large" })).toBe("image too large");
    expect(failureReason("offline")).toBe("offline");
  });

  it("falls back to a plain sentence when there is nothing to say", () => {
    expect(failureReason(new Error("  "))).toBe("the message could not be sent");
    expect(failureReason(undefined)).toBe("the message could not be sent");
  });
});

describe("sendRequest", () => {
  it("reports the intake send once the server has taken it", async () => {
    const archiveIntake = vi.fn(async () => undefined);
    const result = await sendRequest({
      startIntake: async () => started,
      sendToIntake: () => handle({ ok: true }, true),
      sendToOrchestrator: () => {
        throw new Error("the orchestrator is not used");
      },
      archiveIntake,
    });
    expect(result).toEqual({ ok: true, messageId: "m1", queued: true, intake: true });
    expect(archiveIntake).not.toHaveBeenCalled();
  });

  it("reports why a failed send did not go out and archives the intake thread it started", async () => {
    const archiveIntake = vi.fn(async () => undefined);
    const result = await sendRequest({
      startIntake: async () => started,
      sendToIntake: () => handle({ ok: false, reason: "environment is disconnected" }),
      sendToOrchestrator: () => handle({ ok: true }),
      archiveIntake,
    });
    expect(result).toEqual({ ok: false, reason: "environment is disconnected" });
    expect(archiveIntake).toHaveBeenCalledExactlyOnceWith(intakeThread.threadId);
  });

  it("still reports the send failure when archiving the intake thread fails too", async () => {
    const result = await sendRequest({
      startIntake: async () => started,
      sendToIntake: () => handle({ ok: false, reason: "dispatch rejected" }),
      sendToOrchestrator: () => handle({ ok: true }),
      archiveIntake: async () => {
        throw new Error("archive failed");
      },
    });
    expect(result).toEqual({ ok: false, reason: "dispatch rejected" });
  });

  it("sends to the orchestrator when the server has no intake threads", async () => {
    const archiveIntake = vi.fn(async () => undefined);
    const ok = await sendRequest({
      startIntake: async () => ({ _tag: "Failure" as const }),
      sendToIntake: () => {
        throw new Error("no intake thread to send to");
      },
      sendToOrchestrator: () => handle({ ok: true }),
      archiveIntake,
    });
    expect(ok).toEqual({ ok: true, messageId: "m1", queued: false, intake: false });

    const failed = await sendRequest({
      startIntake: async () => ({ _tag: "Failure" as const }),
      sendToIntake: () => handle({ ok: true }),
      sendToOrchestrator: () => handle({ ok: false, reason: "offline" }),
      archiveIntake,
    });
    expect(failed).toEqual({ ok: false, reason: "offline" });
    expect(archiveIntake).not.toHaveBeenCalled();
  });
});
