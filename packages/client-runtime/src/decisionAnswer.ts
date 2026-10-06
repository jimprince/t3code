/** What Brad picked on a decision: a listed option, his own words under Other, or an open question's answer. */
export type DecisionPick =
  | { readonly kind: "option"; readonly option: string }
  | { readonly kind: "other"; readonly text: string }
  | { readonly kind: "open"; readonly text: string };

export interface DecisionAnswerInput {
  readonly decision: "option" | "answer";
  readonly option?: string;
  readonly answer?: string;
  readonly reason?: string;
}

/**
 * The decide payload for a pick plus its optional note. Other and an open question
 * both post "Brad answered"; only a listed option posts "Brad chose". Null when
 * there is nothing to send, so an empty Other is refused.
 */
export function decisionAnswerInput(pick: DecisionPick, note: string): DecisionAnswerInput | null {
  const given = (pick.kind === "option" ? pick.option : pick.text).trim();
  if (!given) return null;
  const reason = note.trim();
  return {
    decision: pick.kind === "option" ? "option" : "answer",
    ...(pick.kind === "option" ? { option: given } : { answer: given }),
    ...(reason ? { reason } : {}),
  };
}

/** Where an answer is once its Undo hold ends: on its way, delivered, or refused with the reason. */
export type DecisionDelivery =
  | { readonly phase: "sending" }
  | {
      readonly phase: "sent";
      /** When the server confirmed it, to tell a list read since from an older one. */
      readonly at: number;
      /** False when the waiting thread could not be found, so only the issue has it. */
      readonly notified: boolean;
    }
  | { readonly phase: "failed"; readonly error: string };

/** A delivery the server just confirmed, stamped now so later list reads can be told apart. */
export function sentDelivery(notified: boolean): DecisionDelivery {
  return { phase: "sent", at: Date.now(), notified };
}

/** An answer Brad gave on a decision card, kept until the card leaves. */
export interface DecisionAnswerRecord<Issue> {
  readonly issue: Issue;
  /** What he picked, as shown on the card. */
  readonly answered: string;
  /** The payload Retry sends again. */
  readonly input: DecisionAnswerInput;
  readonly delivery: DecisionDelivery;
}

/**
 * The answers whose cards are still on screen. A sent answer leaves once a list read
 * after it was sent no longer has its issue; until then, and while sending or failed,
 * its card shows the answer, never the options again. Returns the same map when
 * nothing left, so callers can prune their state without looping.
 */
export function keptDecisionAnswers<Issue>(
  answers: ReadonlyMap<string, DecisionAnswerRecord<Issue>>,
  liveKeys: ReadonlySet<string>,
  listReadAt: number,
): ReadonlyMap<string, DecisionAnswerRecord<Issue>> {
  const left = [...answers].filter(
    ([key, record]) =>
      record.delivery.phase === "sent" && listReadAt > record.delivery.at && !liveKeys.has(key),
  );
  if (left.length === 0) return answers;
  const next = new Map(answers);
  for (const [key] of left) next.delete(key);
  return next;
}

/** The status line of an answered card: held with Undo, sending, sent, or failed with Retry. */
export function decisionSendStrip(
  state: "held" | DecisionDelivery,
  waiting: string,
): { readonly text: string; readonly undoable: boolean; readonly retryable: boolean } {
  if (state === "held") {
    return { text: `Sending to ${waiting} in a moment`, undoable: true, retryable: false };
  }
  const text =
    state.phase === "sending"
      ? `Sending to ${waiting}`
      : state.phase === "sent"
        ? state.notified
          ? `Sent to ${waiting}`
          : `Posted on the issue; ${waiting} was not found`
        : `Not sent: ${state.error}`;
  return { text, undoable: false, retryable: state.phase === "failed" };
}
