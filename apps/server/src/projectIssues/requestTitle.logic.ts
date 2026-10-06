import type { RequestKind } from "../textGeneration/RequestItemsPrompt.ts";
import { parseRequestMarker } from "./projectIssues.logic.ts";

/** Titles read as a deliverable on the board, so they stay short. */
export const MAX_TITLE_LENGTH = 70;
const MIN_WORD_CUT = 20;

const URL_PATTERN = /\bhttps?:\/\/[^\s<>)"']+/gi;
const EMOJI = /\p{Extended_Pictographic}|\u{FE0F}|\u{200D}|\u{20E3}/gu;
const GREETEES = "there|team|all|guys|everyone|claude|codex|agent|orchestrator|chief";

/** Words that name no deliverable. Each pattern is peeled off the front until none match. */
const LEAD_FILLERS: ReadonlyArray<{ pattern: RegExp; asks?: true }> = [
  {
    pattern: new RegExp(`^(?:hey|hi|hello|yo|howdy)(?:\\s+(?:${GREETEES}))?\\s*[,:;!.-]+\\s*`, "i"),
  },
  { pattern: new RegExp(`^(?:hey|hi|hello|yo|howdy)\\s+(?:${GREETEES})\\s+`, "i") },
  { pattern: /^(?:ok(?:ay)?|yes|yeah|yep|and|but|then|now|right)\s*[,:;.!-]+\s*/i },
  {
    pattern:
      /^(?:ok(?:ay)?|yes|yeah|yep|and|but|then|now)\s+(?=(?:so|well|now|then|please|can you|could you|would you)\b)/i,
  },
  {
    pattern:
      /^(?:so|well|alright|also|anyway|btw|oh|um+|uh+|hmm+|actually|basically|just|thanks?|thank you|cheers)\b\s*[,:;.!-]*\s*/i,
  },
  { pattern: /^(?:please|pls|plz)\b\s*[,:;-]*\s*/i, asks: true },
];

/** "Can you X", "I want to X", "let's X": a request frame around an imperative. Tasks only. */
const REQUEST_FRAMES: ReadonlyArray<RegExp> = [
  /^(?:can|could|would|will)\s+(?:you|u)\s+(?:(?:please|also|just|maybe)\s+)*/i,
  /^(?:i\s+was\s+|i'm\s+|i\s+am\s+)?(?:wondering|curious)\s+(?:if|whether)\s+(?:you|we)\s+(?:could|can|would|might)\s+(?:please\s+)?/i,
  /^(?:i|we)\s*(?:'d|\s+would)\s+like\s+(?:you\s+)?to\s+/i,
  /^(?:i|we)\s+(?:want|need|wanna)\s+(?:you\s+)?to\s+/i,
  /^(?:i|we)\s+(?:want|need)\s+/i,
  /^let'?s\s+/i,
  /^(?:we|you)\s+(?:should|need\s+to|have\s+to|must|ought\s+to)\s+/i,
  /^(?:i\s+)?(?:think|guess)\s+(?:we|you)\s+(?:should|could)\s+/i,
  /^(?:go\s+ahead\s+and|feel\s+free\s+to)\s+/i,
];

const TRAILING_POLITE = /(?:[,;]?\s+(?:please|pls|thanks|thank you|thx|cheers))+[\s.!?,]*$/i;
const DANGLING_WORD = /\s+(?:and|or|the|a|an|to|of|for|in|on|with|that|which|so|but|is|are)$/i;
const KEEP_LOWER = new Set(["npm", "pnpm", "npx", "git", "gh", "stg", "tsc", "ios", "macos"]);

/** One line: URLs reduced to their host, emoji and markdown chrome dropped. */
function tidy(text: string): string {
  return text
    .replace(URL_PATTERN, (url) => {
      try {
        return new URL(url).host;
      } catch {
        return "";
      }
    })
    .replace(EMOJI, "")
    .replace(/[‘’]/g, "'")
    .replace(/(\*\*|__)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:>+|#{1,6}|[-*•])\s+/, "");
}

/**
 * Peels filler and (for work) request frames off the front. `asked` reports that
 * the sentence was phrased as a request, which makes it a task even with a "?".
 */
function stripLead(text: string, frames: boolean): { text: string; asked: boolean } {
  let current = text;
  let asked = false;
  for (let pass = 0; pass < 8; pass++) {
    const before = current;
    for (const { pattern, asks } of LEAD_FILLERS) {
      const match = pattern.exec(current);
      if (!match) continue;
      current = current.slice(match[0].length);
      asked ||= asks === true;
    }
    if (frames) {
      for (const pattern of REQUEST_FRAMES) {
        const match = pattern.exec(current);
        if (!match) continue;
        current = current.slice(match[0].length);
        asked = true;
      }
    }
    if (current === before) break;
  }
  return { text: current.trim(), asked };
}

function capitalize(text: string): string {
  const first = /^[a-z]+(?=\s|$)/.exec(text)?.[0];
  return first && !KEEP_LOWER.has(first) ? text[0]!.toUpperCase() + text.slice(1) : text;
}

/** Cut at a word boundary, never mid-word, and never on a dangling connector. */
function capLength(text: string): string {
  if (text.length <= MAX_TITLE_LENGTH) return text;
  const room = MAX_TITLE_LENGTH - 3;
  const lookahead = text.slice(0, room + 1);
  const cut = lookahead.lastIndexOf(" ");
  const kept = (cut >= MIN_WORD_CUT ? lookahead.slice(0, cut) : text.slice(0, room))
    .replace(/[\s,;:(-]+$/, "")
    .replace(DANGLING_WORD, "");
  return `${kept}...`;
}

/**
 * A model or fallback title as a board title: filler, greetings, politeness and
 * (for work) request frames removed, one line, capitalized, no trailing period
 * (or question mark, for work), capped at a word boundary. Empty when nothing
 * but filler was said.
 */
export function cleanRequestTitle(title: string, kind: RequestKind): string {
  const lead = stripLead(tidy(title), kind !== "question").text;
  const body = lead.replace(TRAILING_POLITE, "").trim();
  const bare = body.replace(/(?:\.{3}|…|[\s.!?,;:])+$/, "");
  const ended = kind === "question" && /\?[\s.!]*$/.test(body) ? `${bare}?` : bare;
  return capLength(capitalize(ended));
}

/** The sentences of one line; a period inside "e.g." or "v0.0.29" does not end one. */
function sentencesOf(line: string): string[] {
  return (line.match(/.+?(?:(?<!\b(?:e\.g|i\.e|vs|etc))[.?!]+(?=\s|$)|$)/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * The title and type for a message nobody could split: the first sentence that
 * says something, cleaned. "Can you X?" is a task, "X?" a question. Any `kind`
 * given (a stored label) wins over the guess.
 */
export function deriveRequestTitle(
  text: string,
  kind?: RequestKind,
): { title: string; kind: RequestKind } {
  const lines = text
    .split("\n")
    .map(tidy)
    .filter((line) => line.length > 0 && !line.startsWith("```"));
  for (const line of lines) {
    for (const sentence of sentencesOf(line)) {
      const asked = stripLead(sentence, true).asked;
      const guessed: RequestKind = !asked && sentence.endsWith("?") ? "question" : "task";
      const title = cleanRequestTitle(sentence, kind ?? guessed);
      if (title.length >= 3) return { title, kind: kind ?? guessed };
    }
  }
  return { title: capLength(lines[0] ?? "New request"), kind: kind ?? "task" };
}

/**
 * Brad's words from a request issue body: the quote under the "Brad's words"
 * heading, or the leading quote of an issue filed before the heading existed.
 */
export function requestWords(body: string | null | undefined): string | null {
  if (!body) return null;
  const lines = body.split("\n");
  const heading = lines.findIndex((line) => /^#{1,6}\s*Brad['’]s words\s*$/i.test(line.trim()));
  const quoted: string[] = [];
  for (const line of lines.slice(heading + 1)) {
    if (line.startsWith(">")) quoted.push(line.replace(/^>\s?/, ""));
    else if (quoted.length > 0 || line.trim() !== "") break;
  }
  return quoted.length > 0 ? quoted.join("\n").trim() : null;
}

const comparable = (title: string) =>
  title
    .replace(/(?:\.{3}|…|[\s.!?])+$/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Whether a title is still Brad's raw first line or first sentence (the whole
 * or a "..." cut of it), as the ledger filed it before titles were derived.
 */
export function isRawTitle(title: string, words: string): boolean {
  const current = comparable(title);
  if (!current) return false;
  const cut = /(?:\.{3}|…)\s*$/.test(title.trim());
  const firstLine = words.split("\n").find((line) => line.trim().length > 0) ?? "";
  return [firstLine, sentencesOf(firstLine)[0] ?? ""].some((candidate) => {
    const raw = comparable(candidate);
    return raw === current || (cut && raw.startsWith(current));
  });
}

/**
 * The new title for a captured request being linked or started, or null to
 * leave it. Only a title that is still Brad's raw words is replaced, so a title
 * a person or agent set is never overwritten; agent-filed requests carry their
 * agent's title and are skipped. Brad's words stay in the body.
 */
export function planRetitle(issue: {
  readonly title: string;
  readonly body: string | null | undefined;
  readonly kind?: RequestKind | undefined;
}): string | null {
  const source = parseRequestMarker(issue.body);
  if (!source || source.messageId.startsWith("agent:")) return null;
  const words = requestWords(issue.body);
  if (!words || !isRawTitle(issue.title, words)) return null;
  const { title } = deriveRequestTitle(words, issue.kind);
  return title !== issue.title.trim() ? title : null;
}
