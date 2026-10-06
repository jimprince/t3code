import { linkifyText, type LinkifiedPart } from "./linkify.ts";

/** A run of a decision's context: plain text, or a link to open. */
export type DecisionContextPart = LinkifiedPart;

/** A picture the context embeds, shown as a thumbnail that opens full size. */
export interface DecisionContextImage {
  readonly alt: string;
  readonly url: string;
}

export interface DecisionContext {
  readonly parts: ReadonlyArray<DecisionContextPart>;
  readonly images: ReadonlyArray<DecisionContextImage>;
  /** Too long for a collapsed card: it gets an expand control. */
  readonly long: boolean;
}

const LONG_CHARS = 280;
const LONG_LINES = 4;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const HTML_ATTRIBUTE = (name: string) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i");
/** A Markdown link; bare URLs in the text between them go through linkifyText. */
const MARKDOWN_LINK = /\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

/** An http(s) URL, with relative ones (Gitea writes `/attachments/<uuid>`) read against the issue. */
function absoluteUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * A decision issue's context as text and links to render, plus the images it embeds
 * (Markdown or the `<img>` tags Gitea's editor writes), which leave the text and
 * become thumbnails. Relative URLs resolve against the issue's own URL.
 */
export function parseDecisionContext(context: string, issueUrl: string): DecisionContext {
  const images: DecisionContextImage[] = [];
  const addImage = (alt: string, source: string) => {
    const url = absoluteUrl(source, issueUrl);
    if (url && !images.some((image) => image.url === url)) images.push({ alt: alt.trim(), url });
  };
  const withoutImages = context
    .replace(MARKDOWN_IMAGE, (_match, alt: string, source: string) => {
      addImage(alt, source);
      return "";
    })
    .replace(HTML_IMAGE, (tag) => {
      const source = HTML_ATTRIBUTE("src").exec(tag)?.[1];
      if (source) addImage(HTML_ATTRIBUTE("alt").exec(tag)?.[1] ?? "", source);
      return "";
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const parts: DecisionContextPart[] = [];
  const push = (part: DecisionContextPart) => {
    const last = parts.at(-1);
    if (part.kind === "text" && last?.kind === "text") {
      parts[parts.length - 1] = { kind: "text", text: last.text + part.text };
    } else if (part.kind === "link" || part.text) {
      parts.push(part);
    }
  };
  const pushProse = (text: string) => linkifyText(text).forEach(push);
  let cursor = 0;
  for (const match of withoutImages.matchAll(MARKDOWN_LINK)) {
    pushProse(withoutImages.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const url = absoluteUrl(match[2]!, issueUrl);
    push(url ? { kind: "link", text: match[1]!, url } : { kind: "text", text: match[1]! });
  }
  pushProse(withoutImages.slice(cursor));

  return {
    parts,
    images,
    long: withoutImages.length > LONG_CHARS || withoutImages.split("\n").length > LONG_LINES,
  };
}

/** The context's visible text, for comparing a short summary with the whole. */
export function decisionContextText(parts: ReadonlyArray<DecisionContextPart>): string {
  return parts.map((part) => part.text).join("");
}
