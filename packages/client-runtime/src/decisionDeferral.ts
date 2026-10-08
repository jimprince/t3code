import type { ProjectIssueDeferral } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DAY_MS = 86_400_000;

/**
 * When a deadline passes, as an instant: a date (`2026-10-08`) is the start of that day,
 * UTC, which is the earliest reading and so the safest one to count a day back from.
 */
const deadlineMs = (deadline: string) => Date.parse(deadline);

export interface DecisionVisibility {
  /** Later is in force: the card stays out of the feed. */
  readonly hidden: boolean;
  /** When a hidden card returns (a day before its deadline at the latest). */
  readonly returnsAt: string | null;
  /** The deadline, not the chosen time, is what brings it back or will. */
  readonly forDeadline: boolean;
}

/**
 * Whether Later hides a card now. A card with a deadline returns the day before it
 * whatever time Brad chose, and says so through `forDeadline`.
 */
export function decisionVisibility(input: {
  readonly deferral?: ProjectIssueDeferral | undefined;
  readonly deadline?: string | undefined;
  readonly now: number;
}): DecisionVisibility {
  const until = input.deferral?.until == null ? null : Date.parse(input.deferral.until);
  if (until === null || Number.isNaN(until) || until <= input.now) {
    return { hidden: false, returnsAt: null, forDeadline: false };
  }
  const deadline = input.deadline === undefined ? Number.NaN : deadlineMs(input.deadline);
  const cutoff = Number.isNaN(deadline) ? Number.POSITIVE_INFINITY : deadline - DAY_MS;
  const forDeadline = cutoff < until;
  const returns = Math.min(until, cutoff);
  return {
    hidden: input.now < returns,
    returnsAt: DateTime.formatIso(DateTime.makeUnsafe(returns)),
    forDeadline,
  };
}

/**
 * Where a card sorts in a feed that is oldest first: when it was filed, or when Brad
 * last moved it to the end if that is later.
 */
export function decisionSortTime(createdAt: string, deferral?: ProjectIssueDeferral): number {
  const moved = deferral?.movedToEndAt == null ? Number.NaN : Date.parse(deferral.movedToEndAt);
  const created = Date.parse(createdAt);
  return Number.isNaN(moved) ? created : Math.max(created, moved);
}
