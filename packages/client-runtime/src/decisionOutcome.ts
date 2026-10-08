/** Where an action on a feed card is: waiting out its Undo hold, on its way, done, or refused. */
export type FeedDelivery =
  | { readonly phase: "held" }
  | { readonly phase: "sending" }
  | {
      readonly phase: "sent";
      /** When the server confirmed it, to tell a list read since from an older one. */
      readonly at: number;
      /** What happened and where it went: "Sent to End Effector Orchestrator". */
      readonly text: string;
    }
  | { readonly phase: "failed"; readonly error: string };

/** The status line of an acted-on card, with whether it offers Undo or Retry. */
export function deliveryStrip(delivery: FeedDelivery): {
  readonly text: string;
  readonly undoable: boolean;
  readonly retryable: boolean;
} {
  switch (delivery.phase) {
    case "held":
      return { text: "Sending in a moment", undoable: true, retryable: false };
    case "sending":
      return { text: "Sending", undoable: false, retryable: false };
    case "sent":
      return { text: delivery.text, undoable: false, retryable: false };
    case "failed":
      return { text: `Not sent: ${delivery.error}`, undoable: false, retryable: true };
  }
}

/** A sent card stays at least this long, so Sent (and Undo) can be read before the next list read. */
export const MIN_SENT_MS = 5000;

/**
 * The acted-on cards still shown. A sent one leaves once a list read after it was sent no
 * longer has its card; until then, while sending, and when failed, the card shows what
 * Brad did and never its actions again. Returns the same map when nothing left.
 */
export function keptOutcomes<T extends { readonly delivery: FeedDelivery }>(
  outcomes: ReadonlyMap<string, T>,
  liveKeys: ReadonlySet<string>,
  listReadAt: number,
  /** The clock, so the minimum time on screen is judged apart from list reads. */
  nowMs: number,
): ReadonlyMap<string, T> {
  const left = [...outcomes].filter(
    ([key, outcome]) =>
      outcome.delivery.phase === "sent" &&
      listReadAt > outcome.delivery.at &&
      nowMs >= outcome.delivery.at + MIN_SENT_MS &&
      !liveKeys.has(key),
  );
  if (left.length === 0) return outcomes;
  const next = new Map(outcomes);
  for (const [key] of left) next.delete(key);
  return next;
}

/**
 * When the earliest sent card still short of its time on screen can leave, or null if none
 * waits. A card already past `after` (the last time the clock was read) is not waited for,
 * so one that is kept for another reason cannot starve the timer of the cards after it.
 */
export function nextOutcomeExpiry(
  outcomes: ReadonlyMap<string, { readonly delivery: FeedDelivery }>,
  after: number,
): number | null {
  let next: number | null = null;
  for (const { delivery } of outcomes.values()) {
    if (delivery.phase !== "sent") continue;
    const expiry = delivery.at + MIN_SENT_MS;
    if (expiry <= after) continue;
    if (next === null || expiry < next) next = expiry;
  }
  return next;
}
