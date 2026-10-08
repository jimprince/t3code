import { describe, expect, it } from "vite-plus/test";

import {
  deliveryStrip,
  keptOutcomes,
  MIN_SENT_MS,
  nextOutcomeExpiry,
  type FeedDelivery,
} from "./decisionOutcome.ts";

describe("deliveryStrip", () => {
  it("says what each phase of an action is, and offers Undo only while held", () => {
    expect(deliveryStrip({ phase: "held" })).toEqual({
      text: "Sending in a moment",
      undoable: true,
      retryable: false,
    });
    expect(deliveryStrip({ phase: "sending" }).undoable).toBe(false);
    expect(deliveryStrip({ phase: "sent", at: 1, text: "Sent to Gripper worker" })).toEqual({
      text: "Sent to Gripper worker",
      undoable: false,
      retryable: false,
    });
    expect(deliveryStrip({ phase: "failed", error: "Gitea refused" })).toEqual({
      text: "Not sent: Gitea refused",
      undoable: false,
      retryable: true,
    });
  });
});

describe("keptOutcomes", () => {
  const sent = (at: number): FeedDelivery => ({ phase: "sent", at, text: "Sent" });
  const outcomes = new Map<string, { delivery: FeedDelivery }>([
    ["old-sent", { delivery: sent(100) }],
    ["live-sent", { delivery: sent(100) }],
    ["fresh-sent", { delivery: sent(100_000) }],
    ["just-sent", { delivery: sent(20_000) }],
    ["failed", { delivery: { phase: "failed", error: "x" } }],
    ["sending", { delivery: { phase: "sending" } }],
  ]);

  it("drops a sent card only once a later list read no longer has it", () => {
    const kept = keptOutcomes(outcomes, new Set(["live-sent"]), 50_000, 60_000);
    expect([...kept.keys()].sort()).toEqual(["failed", "fresh-sent", "live-sent", "sending"]);
  });

  it("keeps a just-sent card on screen for a few seconds even when a read already lacks it", () => {
    const kept = keptOutcomes(outcomes, new Set(), 90_000, 20_000 + MIN_SENT_MS - 1);
    expect(kept.has("just-sent")).toBe(true);
    expect(
      keptOutcomes(outcomes, new Set(), 90_000, 20_000 + MIN_SENT_MS + 1).has("just-sent"),
    ).toBe(false);
  });

  it("returns the same map when nothing left, so state does not churn", () => {
    expect(
      keptOutcomes(outcomes, new Set(["old-sent", "live-sent", "just-sent"]), 50_000, 60_000),
    ).toBe(outcomes);
  });
});

describe("a card whose list read already lacks it", () => {
  const outcome = { delivery: { phase: "sent", at: 1_000, text: "Sent" } as FeedDelivery };

  it("leaves once the time on screen is up, with no further list read", () => {
    const outcomes = new Map([["k", outcome]]);
    // The read that lacks it happened right after the action, inside the dwell.
    expect(keptOutcomes(outcomes, new Set(), 1_500, 1_000 + MIN_SENT_MS - 1).has("k")).toBe(true);
    expect(keptOutcomes(outcomes, new Set(), 1_500, 1_000 + MIN_SENT_MS).has("k")).toBe(false);
  });

  it("stays while no read has happened since it was sent", () => {
    expect(keptOutcomes(new Map([["k", outcome]]), new Set(), 900, 100_000).has("k")).toBe(true);
  });
});

describe("nextOutcomeExpiry", () => {
  it("is the earliest sent card's time, ignoring cards still in flight", () => {
    const outcomes = new Map<string, { delivery: FeedDelivery }>([
      ["a", { delivery: { phase: "sent", at: 9_000, text: "x" } }],
      ["b", { delivery: { phase: "sent", at: 4_000, text: "x" } }],
      ["c", { delivery: { phase: "sending" } }],
    ]);
    expect(nextOutcomeExpiry(outcomes, 0)).toBe(4_000 + MIN_SENT_MS);
    expect(nextOutcomeExpiry(new Map(), 0)).toBeNull();
  });

  it("does not wait for a card already past its time, so it cannot starve the ones after it", () => {
    const outcomes = new Map<string, { delivery: FeedDelivery }>([
      ["kept-past", { delivery: { phase: "sent", at: 1_000, text: "x" } }],
      ["new", { delivery: { phase: "sent", at: 50_000, text: "x" } }],
    ]);
    expect(nextOutcomeExpiry(outcomes, 40_000)).toBe(50_000 + MIN_SENT_MS);
    expect(nextOutcomeExpiry(outcomes, 50_000 + MIN_SENT_MS)).toBeNull();
  });
});
