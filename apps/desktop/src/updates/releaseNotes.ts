import type { DesktopUpdateReleaseNote } from "@t3tools/contracts";

interface ElectronReleaseNoteInfo {
  readonly version: string;
  readonly note: string | null | undefined;
}

function isElectronReleaseNoteInfo(value: unknown): value is ElectronReleaseNoteInfo {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { readonly version?: unknown; readonly note?: unknown };
  return (
    typeof candidate.version === "string" &&
    (typeof candidate.note === "string" || candidate.note === null || candidate.note === undefined)
  );
}

const MAX_RELEASE_NOTE_GROUPS = 6;
const MAX_RELEASE_NOTE_ITEMS_PER_GROUP = 8;
const MAX_RELEASE_NOTE_ITEM_LENGTH = 220;

const HTML_ENTITY_REPLACEMENTS: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeCodePoint(codePoint: number, entity: string): string {
  // String.fromCodePoint throws RangeError outside the valid Unicode range, and
  // Number.isFinite alone lets oversized values (e.g. &#9999999999;) through.
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return `&${entity};`;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntity(entity: string): string {
  const named = HTML_ENTITY_REPLACEMENTS[entity];
  if (named) return named;
  if (entity.startsWith("#x")) {
    return decodeCodePoint(Number.parseInt(entity.slice(2), 16), entity);
  }
  if (entity.startsWith("#")) {
    return decodeCodePoint(Number.parseInt(entity.slice(1), 10), entity);
  }
  return `&${entity};`;
}

function decodeHtmlEntities(input: string): string {
  return input.replace(/&([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);/g, (_, entity: string) =>
    decodeHtmlEntity(entity),
  );
}

// Structural normalization only. Markdown link/bold syntax is stripped later,
// per line, *after* isIgnoredReleaseNoteLine has had a chance to see the raw
// URL — stripping links here first would turn a footer line like
// "[Upstream compare](https://.../compare/...)" into the bare text
// "Upstream compare", which no longer contains "/compare/" and would then
// slip past the filter as a fake change.
function stripHtml(input: string): string {
  return decodeHtmlEntities(
    input
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${"#".repeat(Number(level))} `)
      .replace(/<\/(?:p|div|li|h[1-6]|ul|ol|blockquote)>/gi, "\n")
      .replace(/<[^>]*>/g, ""),
  );
}

function stripInlineMarkup(input: string): string {
  return input.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1");
}

function truncateReleaseNoteItem(item: string): string {
  if (item.length <= MAX_RELEASE_NOTE_ITEM_LENGTH) return item;
  return `${item.slice(0, MAX_RELEASE_NOTE_ITEM_LENGTH - 3).trimEnd()}...`;
}

function normalizeReleaseNoteLine(line: string): string {
  return line
    .toLowerCase()
    .replace(/[*_`#]/g, "")
    .trim();
}

function isIgnoredReleaseNoteLine(line: string): boolean {
  const normalized = normalizeReleaseNoteLine(line);
  return (
    normalized === "" ||
    normalized === "what's changed" ||
    normalized === "whats changed" ||
    normalized.startsWith("compare: ") ||
    normalized.includes("/compare/") ||
    // The upstream/fork subject lists append a "- +N more ... changes"
    // summary bullet once truncated; it is a footer, not a change.
    /^\+\d+ more\b.*\bchanges?$/.test(normalized)
  );
}

interface ExtractedReleaseNoteItems {
  readonly items: ReadonlyArray<string>;
  readonly totalItems: number;
}

// Release note bodies are authored most-important-first (both our own
// render-release-notes script and the fork's own change-entry sections put
// the highest-priority content at the top), so the first items encountered
// are exactly the ones worth keeping under the per-group cap. Preserving
// that order end-to-end is what the popup renders top to bottom.
function extractReleaseNoteItems(note: string | null | undefined): ExtractedReleaseNoteItems {
  if (!note) return { items: [], totalItems: 0 };

  const items: string[] = [];
  let totalItems = 0;
  for (const rawLine of stripHtml(note).split("\n")) {
    const withoutPrefix = rawLine
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/\s+/g, " ");
    const normalized = normalizeReleaseNoteLine(withoutPrefix);
    if (normalized === "new contributors" || normalized === "full changelog") break;
    if (/^#{1,6}\s+/.test(withoutPrefix)) continue;
    // Checked before the link/bold syntax is stripped, so a compare/changelog
    // link's URL is still there to match against.
    if (isIgnoredReleaseNoteLine(withoutPrefix)) continue;
    const item = stripInlineMarkup(withoutPrefix).trim().replace(/\s+/g, " ");
    if (!item) continue;
    totalItems += 1;
    if (items.length < MAX_RELEASE_NOTE_ITEMS_PER_GROUP) {
      items.push(truncateReleaseNoteItem(item));
    }
  }
  return { items, totalItems };
}

interface NormalizedDesktopUpdateReleaseNotes {
  readonly releaseNotes: ReadonlyArray<DesktopUpdateReleaseNote>;
  readonly omittedReleaseCount: number;
}

export function normalizeDesktopUpdateReleaseNotes(
  releaseNotes: unknown,
  fallbackVersion: string,
): NormalizedDesktopUpdateReleaseNotes {
  const rawNotes =
    typeof releaseNotes === "string"
      ? [{ version: fallbackVersion, note: releaseNotes }]
      : Array.isArray(releaseNotes)
        ? releaseNotes.filter(isElectronReleaseNoteInfo)
        : [];

  const normalizedNotes = rawNotes.flatMap((entry) => {
    const { items, totalItems } = extractReleaseNoteItems(entry.note);
    if (totalItems === 0) return [];
    return [
      {
        version: entry.version,
        items,
        totalItems,
      },
    ];
  });

  return {
    releaseNotes: normalizedNotes.slice(0, MAX_RELEASE_NOTE_GROUPS),
    omittedReleaseCount: Math.max(0, normalizedNotes.length - MAX_RELEASE_NOTE_GROUPS),
  };
}
