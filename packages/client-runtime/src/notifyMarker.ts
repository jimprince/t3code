/**
 * Display side of the `T3_NOTIFY: quiet|attention` routing marker.
 *
 * An agent ends a message with that line to steer notifications. It is routing, not
 * content, so display paths drop it. Stored text and the detectors that read it
 * (`notificationDispositionForReply`, `backgroundTurns`, the t3-thread watcher) are
 * unchanged and keep seeing the marker.
 */

const TRAILING_MARKER = /(?:^|\r?\n)T3_NOTIFY:[ \t]*(?:quiet|attention)\s*$/;
const MARKER_LINES = ["T3_NOTIFY: quiet", "T3_NOTIFY: attention"];
/** Shorter partial lines are ordinary text ("T", "T3 Code ..."); hiding them would flicker. */
const MIN_PARTIAL_MARKER_CHARS = 2;
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;

/** Whether `text` ends inside an unclosed fenced code block, where a marker line is author content. */
function endsInsideFence(text: string): boolean {
  let open: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const fence = FENCE_LINE.exec(line)?.[1];
    if (fence === undefined) continue;
    if (open === null) {
      open = fence;
    } else if (fence[0] === open[0] && fence.length >= open.length && line.trim() === fence) {
      open = null;
    }
  }
  return open !== null;
}

/**
 * Text as a person should read it: without a trailing `T3_NOTIFY: quiet|attention` line.
 *
 * Only the last line is removed, with the newline before it. A marker in the middle of the
 * text, quoted in prose, or inside a fenced code block stays visible. `streaming` also
 * hides a marker still arriving (`T3_NOTI`) so it never flashes before it completes.
 */
export function stripNotifyMarker(
  text: string,
  options?: { readonly streaming?: boolean },
): string {
  const match = TRAILING_MARKER.exec(text);
  if (match !== null) {
    const before = text.slice(0, match.index);
    return endsInsideFence(before) ? text : before.trimEnd();
  }
  if (options?.streaming !== true) return text;
  const lineStart = text.lastIndexOf("\n") + 1;
  const lastLine = text.slice(lineStart);
  if (
    lastLine.length < MIN_PARTIAL_MARKER_CHARS ||
    !MARKER_LINES.some((marker) => marker.startsWith(lastLine))
  ) {
    return text;
  }
  const before = text.slice(0, lineStart).replace(/\r?\n$/, "");
  return endsInsideFence(before) ? text : before.trimEnd();
}
