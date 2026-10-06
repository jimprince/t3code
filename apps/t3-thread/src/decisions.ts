export interface DecisionAnswerFlags {
  readonly option?: string;
  readonly answer?: string;
  readonly approve?: boolean;
  readonly notYet?: boolean;
  readonly note?: string;
}

/**
 * The `projectRequests.decide` payload for `decision answer`: exactly one of
 * --option, --answer, --approve or --not-yet, with --note as the line of why
 * (the reason, for not yet). The same payload the Decisions widget and Needs you send.
 */
export function decisionAnswerPayload(flags: DecisionAnswerFlags): {
  decision: "option" | "answer" | "approve" | "not-yet";
  option?: string;
  answer?: string;
  reason?: string;
} {
  const chosen = [
    flags.option !== undefined && "--option",
    flags.answer !== undefined && "--answer",
    flags.approve === true && "--approve",
    flags.notYet === true && "--not-yet",
  ].filter((flag) => flag !== false);
  if (chosen.length !== 1) {
    throw new Error("Give exactly one of --option, --answer, --approve or --not-yet.");
  }
  const note = flags.note?.trim();
  const reason = note ? { reason: note } : {};
  if (flags.option !== undefined) {
    if (!flags.option.trim()) throw new Error("--option needs the option's text.");
    return { decision: "option", option: flags.option, ...reason };
  }
  if (flags.answer !== undefined) {
    if (!flags.answer.trim()) throw new Error("--answer needs Brad's answer.");
    return { decision: "answer", answer: flags.answer, ...reason };
  }
  return { decision: flags.approve ? "approve" : "not-yet", ...reason };
}
