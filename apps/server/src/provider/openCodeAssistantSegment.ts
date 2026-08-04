/**
 * Marks whether an OpenCode assistant-message completion ends the turn.
 *
 * OpenCode narrates before calling a tool, and some models (GLM via OpenRouter
 * reproduces this on every turn) emit that narration as its own assistant
 * message finishing with `finish: "tool-calls"`. The adapter still completes
 * that text segment so the UI can close it, so `item.completed` alone cannot
 * mean "the turn ended" — turn-level recovery that reads it that way settles
 * the thread while OpenCode is still working.
 *
 * The marker rides on the item payload's free-form `data`, which is not
 * projected for assistant messages, so no shared contract changes.
 */

const SEGMENT_KEY = "openCodeAssistantSegment";

export interface OpenCodeAssistantSegmentData {
  readonly [SEGMENT_KEY]: { readonly messageTerminal: boolean };
}

export function openCodeAssistantSegmentData(
  messageTerminal: boolean,
): OpenCodeAssistantSegmentData {
  return { [SEGMENT_KEY]: { messageTerminal } };
}

/**
 * Reads the marker from an item payload's `data`. Returns `undefined` when the
 * event carries no marker — another provider, or an OpenCode event recorded
 * before the marker existed — so callers can keep their previous behaviour
 * instead of stranding a turn.
 */
export function openCodeAssistantSegmentIsTerminal(data: unknown): boolean | undefined {
  if (data === null || typeof data !== "object") {
    return undefined;
  }
  const segment = (data as Record<string, unknown>)[SEGMENT_KEY];
  if (segment === null || typeof segment !== "object") {
    return undefined;
  }
  const messageTerminal = (segment as Record<string, unknown>).messageTerminal;
  return typeof messageTerminal === "boolean" ? messageTerminal : undefined;
}
