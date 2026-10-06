import type { MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  attemptKey,
  failureReason,
  sendRequest,
  type SendHandle,
  type SendOutcome,
} from "./sendOutcome.logic";

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

const KEY = attemptKey("fix the login page", []);

describe("attemptKey", () => {
  it("changes with the text or the images, so an edited request is a new one", () => {
    expect(attemptKey("a", ["i1"])).toBe(attemptKey("a", ["i1"]));
    expect(attemptKey("a", ["i1"])).not.toBe(attemptKey("b", ["i1"]));
    expect(attemptKey("a", ["i1"])).not.toBe(attemptKey("a", ["i1", "i2"]));
  });
});

describe("sendRequest", () => {
  it("reports the intake send once the server has taken it", async () => {
    const result = await sendRequest({
      key: KEY,
      startIntake: async () => started,
      sendToIntake: () => handle({ ok: true }, true),
      sendToOrchestrator: () => {
        throw new Error("the orchestrator is not used");
      },
    });
    expect(result).toEqual({ ok: true, messageId: "m1", queued: true, intake: true });
  });

  it("reports why a failed send did not go out and hands back the attempt to retry", async () => {
    const result = await sendRequest({
      key: KEY,
      startIntake: async () => started,
      sendToIntake: () => handle({ ok: false, reason: "environment is disconnected" }),
      sendToOrchestrator: () => handle({ ok: true }),
    });
    expect(result).toEqual({
      ok: false,
      reason: "environment is disconnected",
      attempt: { key: KEY, messageId: "m1", intake: intakeThread },
    });
  });

  it("files exactly one outbox entry when a failed send is retried", async () => {
    // The outbox dedupes on message id, as the server's enqueue does.
    const outbox = new Map<string, string>();
    let nextId = 0;
    const startIntake = vi.fn(async () => started);
    const send = (messageId: MessageId | undefined, outcome: SendOutcome): SendHandle => {
      const id = messageId ?? (`m${(nextId += 1)}` as MessageId);
      outbox.set(id, "fix the login page");
      return { messageId: id, queued: false, done: Promise.resolve(outcome) };
    };
    const deps = {
      key: KEY,
      startIntake,
      sendToOrchestrator: () => {
        throw new Error("the orchestrator is not used");
      },
    };

    const first = await sendRequest({
      ...deps,
      sendToIntake: (_intake: typeof intakeThread, messageId: MessageId | undefined) =>
        send(messageId, { ok: false, reason: "offline" }),
    });
    expect(first.ok).toBe(false);
    if (first.ok) return;

    const retry = await sendRequest({
      ...deps,
      previous: first.attempt,
      sendToIntake: (_intake: typeof intakeThread, messageId: MessageId | undefined) =>
        send(messageId, { ok: true }),
    });
    expect(retry).toMatchObject({ ok: true, messageId: first.attempt.messageId, intake: true });
    expect(outbox.size).toBe(1);
    expect(startIntake).toHaveBeenCalledTimes(1);
  });

  it("sends to the orchestrator when the server has no intake threads", async () => {
    const ok = await sendRequest({
      key: KEY,
      startIntake: async () => ({ _tag: "Failure" as const }),
      sendToIntake: () => {
        throw new Error("no intake thread to send to");
      },
      sendToOrchestrator: () => handle({ ok: true }),
    });
    expect(ok).toEqual({ ok: true, messageId: "m1", queued: false, intake: false });

    const failed = await sendRequest({
      key: KEY,
      startIntake: async () => ({ _tag: "Failure" as const }),
      sendToIntake: () => handle({ ok: true }),
      sendToOrchestrator: () => handle({ ok: false, reason: "offline" }),
    });
    expect(failed).toEqual({
      ok: false,
      reason: "offline",
      attempt: { key: KEY, messageId: "m1", intake: null },
    });
  });

  it("retries an orchestrator send without asking for an intake thread again", async () => {
    const startIntake = vi.fn(async () => ({ _tag: "Failure" as const }));
    const sendToOrchestrator = vi.fn((messageId: MessageId | undefined) => {
      expect(messageId).toBe("m1");
      return handle({ ok: true });
    });
    const retry = await sendRequest({
      key: KEY,
      previous: { key: KEY, messageId: "m1" as MessageId, intake: null },
      startIntake,
      sendToIntake: () => {
        throw new Error("no intake thread to send to");
      },
      sendToOrchestrator,
    });
    expect(retry).toMatchObject({ ok: true, intake: false });
    expect(startIntake).not.toHaveBeenCalled();
  });
});
