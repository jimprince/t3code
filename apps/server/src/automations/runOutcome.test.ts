import type { OrchestrationLatestTurn, OrchestrationSession } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unboundRunOutcome } from "./runOutcome.ts";

const SENT = "2026-10-06T13:30:01.076Z";

const turn = (
  state: OrchestrationLatestTurn["state"],
  requestedAt = SENT,
): OrchestrationLatestTurn =>
  ({
    turnId: "turn-1",
    state,
    requestedAt,
    startedAt: requestedAt,
    completedAt: state === "running" ? null : "2026-10-06T13:30:29.450Z",
    assistantMessageId: null,
  }) as OrchestrationLatestTurn;

const session = (
  status: OrchestrationSession["status"],
  updatedAt: string,
  lastError: string | null = null,
): OrchestrationSession => ({ status, updatedAt, lastError }) as unknown as OrchestrationSession;

describe("unboundRunOutcome", () => {
  it("waits on the run's turn even when the session last stopped before the message", () => {
    // #164: the stale stop from the previous turn used to fail the run at once.
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        latestTurn: turn("running"),
        session: session("stopped", "2026-10-06T13:20:00.000Z"),
      }),
    ).toBeNull();
  });

  it("completes when the turn requested from the message completes", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        latestTurn: turn("completed"),
        session: session("stopped", "2026-10-06T13:30:30.000Z"),
      }),
    ).toEqual({ status: "completed", result: "Turn completed." });
  });

  it("fails with the turn's state when that turn ends any other way", () => {
    expect(
      unboundRunOutcome({ messageCreatedAt: SENT, latestTurn: turn("interrupted"), session: null }),
    ).toEqual({ status: "failed", result: "Turn interrupted." });
  });

  it("ignores an older turn and a stale stop while the run's turn has not started", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        latestTurn: turn("completed", "2026-10-06T12:00:00.000Z"),
        session: session("stopped", "2026-10-06T12:10:00.000Z"),
      }),
    ).toBeNull();
  });

  it("fails when the session stops or errors after the message and no turn started", () => {
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        latestTurn: turn("completed", "2026-10-06T12:00:00.000Z"),
        session: session("error", "2026-10-06T13:30:02.000Z", "Provider crashed."),
      }),
    ).toEqual({ status: "failed", result: "Provider crashed." });
    expect(
      unboundRunOutcome({
        messageCreatedAt: SENT,
        latestTurn: null,
        session: session("stopped", "2026-10-06T13:30:02.000Z"),
      }),
    ).toEqual({ status: "failed", result: "Provider session stopped before completion." });
  });
});
