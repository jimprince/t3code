/** A run of text: plain, or a web link to open in a new tab or the system browser. */
export type LinkifiedPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly url: string };

const URL_CANDIDATE = /https?:\/\/[^\s<>"'`]+/gi;
/** Sentence punctuation that ends a URL in prose rather than belonging to it. */
const TRAILING = /[.,;:!?'"*_]$/;

const count = (text: string, character: string) => text.split(character).length - 1;

/** Drops trailing punctuation, and a closing bracket the URL itself never opened. */
function trimUrl(candidate: string): string {
  let url = candidate;
  for (;;) {
    if (TRAILING.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(")") && count(url, ")") > count(url, "(")) url = url.slice(0, -1);
    else if (url.endsWith("]") && count(url, "]") > count(url, "[")) url = url.slice(0, -1);
    else return url;
  }
}

/**
 * Splits plain text into text and http(s) links, for decision cards and anything else that
 * shows an agent's prose. Only http and https become links; trailing punctuation stays text.
 */
export function linkifyText(text: string): LinkifiedPart[] {
  const parts: LinkifiedPart[] = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts.at(-1);
    if (last?.kind === "text") parts[parts.length - 1] = { kind: "text", text: last.text + value };
    else parts.push({ kind: "text", text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(URL_CANDIDATE)) {
    const url = trimUrl(match[0]);
    pushText(text.slice(cursor, match.index));
    cursor = match.index + url.length;
    let valid = false;
    try {
      const parsed = new URL(url);
      valid =
        (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname !== "";
    } catch {
      valid = false;
    }
    if (valid) parts.push({ kind: "link", text: url, url });
    else pushText(url);
  }
  pushText(text.slice(cursor));
  return parts;
}

/** The distinct links in a piece of text, in order. */
export function textLinks(text: string): string[] {
  return [
    ...new Set(linkifyText(text).flatMap((part) => (part.kind === "link" ? [part.url] : []))),
  ];
}
