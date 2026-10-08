const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** Emphasis and code markers off a line; links and images stay for the link parser. */
function stripInline(line: string): string {
  return line
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}

/**
 * One Markdown block as plain lines for a native text view: bullets become "•", a table
 * becomes one "a | b | c" line per row (its rule line dropped), headings lose their
 * hashes, emphasis markers go. Links and images are left in Markdown for the context link
 * parser, so they still open.
 */
export function markdownBlockText(block: string): string {
  const lines = block.split("\n").flatMap((raw) => {
    if (TABLE_RULE.test(raw) && raw.includes("-")) return [];
    const row = TABLE_ROW.exec(raw);
    if (row) {
      return [
        row[1]!
          .split("|")
          .map((cell) => stripInline(cell.trim()))
          .join(" | "),
      ];
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(raw);
    if (heading) return [stripInline(heading[1]!)];
    const bullet = BULLET.exec(raw);
    if (bullet) return [`${bullet[1]}• ${stripInline(bullet[2]!)}`];
    const ordered = ORDERED.exec(raw);
    if (ordered) return [`${ordered[1]}${ordered[2]}. ${stripInline(ordered[3]!)}`];
    return [stripInline(raw.replace(/^\s*>\s?/, ""))];
  });
  return lines.join("\n");
}
