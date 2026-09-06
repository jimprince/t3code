import { TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isLatestTurnSettled } from "./session-logic";

describe("isLatestTurnSettled", () => {
  const runningTurnMissingCompletion = {
    turnId: TurnId.make("turn-1"),
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: null,
  } as const;

  it("REGRESSION: a stopped session settles the turn even if turn-diff-completed was dropped", () => {
    // Reproduces "says running when it's not": the reducer leaves
    // latestTurn.state === 'running' (no completedAt) when a session stop is
    // requested, and a dropped `thread.turn-diff-completed` never fills it in.
    // The session is authoritative: stopped => settled => no stuck spinner.
    expect(
      isLatestTurnSettled(runningTurnMissingCompletion, {
        status: "stopped",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("REGRESSION: a ready session settles the turn even with no completion timestamp", () => {
    expect(
      isLatestTurnSettled(runningTurnMissingCompletion, {
        status: "ready",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("REGRESSION: an errored/idle session settles the turn even with no completion timestamp", () => {
    expect(
      isLatestTurnSettled(runningTurnMissingCompletion, {
        status: "error",
        activeTurnId: null,
      }),
    ).toBe(true);
    expect(
      isLatestTurnSettled(runningTurnMissingCompletion, {
        status: "idle",
        activeTurnId: null,
      }),
    ).toBe(true);
  });

  it("still reports a running session as unsettled when completion is missing", () => {
    expect(
      isLatestTurnSettled(runningTurnMissingCompletion, {
        status: "running",
        activeTurnId: TurnId.make("turn-1"),
      }),
    ).toBe(false);
  });
});
