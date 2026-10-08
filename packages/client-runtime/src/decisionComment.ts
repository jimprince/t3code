import type { ProjectIssue } from "@t3tools/contracts";

/** A comment that is never an answer: a progress note, a curator note or Brad's own follow-up. */
export const isNotAnswer = (body: string) =>
  /^\s*(?:progress:|curator:|follow-up from brad\b)/i.test(body.replace(/<!--[\s\S]*?-->/g, ""));

/**
 * An answer shown under its question: the first one to three sentences of the
 * reply, whole (never cut mid-sentence), without markdown markers.
 */
export function answerSentences(text: string, limit = 3): string {
  const plain = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\*\*|__|`|^#+\s*|^>\s*|^[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g) ?? [plain];
  return sentences
    .slice(0, limit)
    .map((sentence) => sentence.trim())
    .join(" ");
}

export interface DecisionOption {
  /** "Option A": the button's label. */
  readonly label: string;
  readonly text: string;
}

/** A Needs you row that asks Brad to choose or approve, with what the buttons need. */
export interface NeedsYouDecision {
  /** One or two whole sentences of what the agent asks. */
  readonly summary: string;
  /** Everything the comment says besides its options, line by line, for More. */
  readonly detail: string;
  readonly recommendation: string | null;
  /** The choices a ready comment lists, at least two; empty when it is a plain approval. */
  readonly options: ReadonlyArray<DecisionOption>;
}

const OPTION_LINE =
  /^(?:[-*]\s+)?(?:[Oo]ption\s+([A-Za-z]|\d{1,2})\s*[:.)–—-]|\(?([A-Z])[:)])\s*(.+)$/;
const RECOMMENDATION_LINE =
  /^(?:[-*]\s+)?(?:(?:my|our)\s+recommendation|recommendation|recommended|i\s+recommend|we\s+recommend)\b\s*[:-]?\s*(.+)$/i;

/**
 * What a ready comment asks of Brad: the choices it lists as lines starting
 * "Option A:" or "A)" (two or more, else they are not choices), its recommendation
 * line, and the rest as the summary.
 */
export function parseDecisionComment(body: string): NeedsYouDecision {
  const lines = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .map((line) => line.replace(/\*\*|__|`/g, "").trim())
    .filter((line) => line.length > 0);
  const options: DecisionOption[] = [];
  let recommendation: string | null = null;
  const rest: string[] = [];
  for (const line of lines) {
    const option = OPTION_LINE.exec(line);
    if (option) {
      options.push({
        label: `Option ${(option[1] ?? option[2]!).toUpperCase()}`,
        text: option[3]!.trim().slice(0, 200),
      });
      continue;
    }
    const recommended = RECOMMENDATION_LINE.exec(line);
    if (recommended && recommendation === null) {
      recommendation = recommended[1]!.trim();
      continue;
    }
    rest.push(line);
  }
  const named = new Set(options.map((option) => option.label));
  const choices = options.length >= 2 && named.size === options.length ? options : [];
  return {
    summary: answerSentences(rest.join(" ").replace(/^\s*(progress|test):\s*/i, ""), 2),
    detail: rest.join("\n").replace(/^\s*(progress|test):\s*/i, ""),
    recommendation,
    options: choices,
  };
}

/**
 * The decision a ready item asks of Brad when its latest comment lists choices
 * ("Option A:" lines), else null; an item with nothing to choose from is a plain approval.
 */
export function readyComment(issue: Pick<ProjectIssue, "latestComment">): NeedsYouDecision {
  return parseDecisionComment(issue.latestComment?.body ?? "");
}
