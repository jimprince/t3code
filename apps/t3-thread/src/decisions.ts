export interface DecisionAnswerFlags {
  readonly option?: string;
  readonly answer?: string;
  readonly approve?: boolean;
  readonly reject?: boolean;
  readonly notYet?: boolean;
  readonly note?: string;
}

/**
 * The `projectRequests.decide` payload for `decision answer`: exactly one of
 * --option, --answer, --approve, --reject or --not-yet, with --note as the line of why
 * (the reason, for not yet). The same payload the Decisions widget and Needs you send.
 */
export function decisionAnswerPayload(flags: DecisionAnswerFlags): {
  decision: "option" | "answer" | "approve" | "reject" | "not-yet";
  option?: string;
  answer?: string;
  reason?: string;
} {
  const chosen = [
    flags.option !== undefined && "--option",
    flags.answer !== undefined && "--answer",
    flags.approve === true && "--approve",
    flags.reject === true && "--reject",
    flags.notYet === true && "--not-yet",
  ].filter((flag) => flag !== false);
  if (chosen.length !== 1) {
    throw new Error("Give exactly one of --option, --answer, --approve, --reject or --not-yet.");
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
  return { decision: flags.approve ? "approve" : flags.reject ? "reject" : "not-yet", ...reason };
}

/** Ready choices use the same 2–5 single-line labels the server's comment parser accepts. */
export function readyOptions(options: readonly string[] = [], recommend?: string) {
  if (options.length === 0 && recommend === undefined) return undefined;
  if (options.length < 2 || options.length > 5) throw new Error("Give 2 to 5 --option labels.");
  if (options.some((text) => !text.trim() || text.length > 200 || /[\r\n]/.test(text)))
    throw new Error("Each --option must be one nonempty line of at most 200 characters.");
  const index = recommend === undefined ? -1 : Number(recommend) - 1;
  if (recommend !== undefined && (!Number.isInteger(index) || index < 0 || index >= options.length))
    throw new Error("--recommend must name a supplied option, numbered from 1.");
  return options.map((text, i) => ({ text, recommended: i === index }));
}
