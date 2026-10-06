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

type DecisionSendPhase = "held" | "sending" | "sent";

/** The strip a decision shows once an answer is picked: held with Undo, then Sending and Sent. */
export function decisionSendStrip(
  phase: DecisionSendPhase,
  waiting: string,
): { readonly text: string; readonly undoable: boolean } {
  if (phase === "held") return { text: `Sent to ${waiting}`, undoable: true };
  return { text: phase === "sending" ? "Sending" : "Sent", undoable: false };
}
