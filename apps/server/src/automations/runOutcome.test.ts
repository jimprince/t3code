import { describe, expect, it } from "vite-plus/test";

import { unboundRunOutcome } from "./runOutcome.ts";

const SENT = "2026-10-06T13:30:01.076Z";

const turn = (state: string, requestedAt = SENT) => ({
  turnId: "turn-1",
  status: state === "error" ? "failed" : state,
  requestedAt,
  startedAt: requestedAt,
  completedAt: state === "running" ? null : "2026-10-06T13:30:29.450Z",
  assistantMessageId: null,
});

const session = (status: string, updatedAt: string, lastError: string | null = null) => ({
  status,
  updatedAt,
  lastError,
});

describe("unboundRunOutcome", () => {
  it("waits on the run's turn even when the session last stopped before the message", () => {
    // #164: the stale stop from the previous turn used to fail the run at once.
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        run: turn("running"),
        session: session("stopped", "2026-10-06T13:20:00.000Z"),
      }),
    ).toBeNull();
  });

  it("completes when the turn requested from the message completes", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        run: turn("completed"),
        session: session("stopped", "2026-10-06T13:30:30.000Z"),
      }),
    ).toEqual({ status: "completed", result: "Turn completed." });
  });

  it("fails with the turn's state when that turn ends any other way", () => {
    expect(
      unboundRunOutcome({ messageCreatedAt: SENT, run: turn("interrupted"), session: null }),
    ).toEqual({ status: "failed", result: "Turn interrupted." });
  });

  it("ignores a stale stop while no run owns the input", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        run: null,
        session: session("stopped", "2026-10-06T12:10:00.000Z"),
      }),
    ).toBeNull();
  });

  it("fails when the session stops or errors after the message and no turn started", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        run: null,
        session: session("error", "2026-10-06T13:30:02.000Z", "Provider crashed."),
      }),
    ).toEqual({ status: "failed", result: "Provider crashed." });
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        run: null,
        session: session("stopped", "2026-10-06T13:30:02.000Z"),
      }),
    ).toEqual({ status: "failed", result: "Provider session stopped before completion." });
  });
});
