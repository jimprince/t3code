/**
 * The canvas action bridge: the few intents a sandboxed canvas may post to its
 * host page. Everything here is pure so the checks are testable; the widget adds
 * the frame identity check (the message must come from its own iframe).
 */

const CANVAS_MESSAGE_TYPE = "t3-canvas";
export const CANVAS_RESULT_TYPE = "t3-canvas-result";

const MAX_TEXT = 4_000;
const MAX_URL = 2_000;

export const CANVAS_HEIGHT = { min: 40, max: 600 } as const;

export type CanvasIntent =
  | { readonly intent: "send"; readonly text: string }
  | { readonly intent: "open-thread"; readonly threadId: string }
  | { readonly intent: "open-issue"; readonly url: string }
  | { readonly intent: "open-url"; readonly url: string }
  | { readonly intent: "resize"; readonly height: number };

export type ParsedCanvasMessage =
  | { readonly ok: true; readonly id: string | null; readonly action: CanvasIntent }
  | {
      readonly ok: false;
      readonly id: string | null;
      readonly intent: string;
      readonly reason: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const shortString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value : null;

/**
 * Reads one posted message. Null when it is not a canvas message at all (other
 * frames and tools post too); otherwise the intent, or why it was refused.
 */
export function parseCanvasMessage(data: unknown): ParsedCanvasMessage | null {
  if (!isRecord(data) || data.type !== CANVAS_MESSAGE_TYPE) return null;
  const id = shortString(data.id, 100);
  const intent = typeof data.intent === "string" ? data.intent.slice(0, 40) : "";
  const refuse = (reason: string): ParsedCanvasMessage => ({ ok: false, id, intent, reason });
  switch (intent) {
    case "send": {
      const text = shortString(data.text, MAX_TEXT);
      return text
        ? { ok: true, id, action: { intent, text: text.trim() } }
        : refuse(`send needs text up to ${MAX_TEXT} characters`);
    }
    case "open-thread": {
      const threadId = shortString(data.threadId, 100);
      return threadId ? { ok: true, id, action: { intent, threadId } } : refuse("missing threadId");
    }
    case "open-issue":
    case "open-url": {
      const url = shortString(data.url, MAX_URL);
      return url ? { ok: true, id, action: { intent, url } } : refuse("missing url");
    }
    case "resize": {
      const { height } = data;
      return typeof height === "number" && Number.isFinite(height)
        ? { ok: true, id, action: { intent, height: clampCanvasHeight(height) } }
        : refuse("resize needs a finite height in pixels");
    }
    default:
      return refuse("unknown intent");
  }
}

/** A frame height as a whole number of pixels within the allowed range. */
export function clampCanvasHeight(height: number): number {
  return Math.min(CANVAS_HEIGHT.max, Math.max(CANVAS_HEIGHT.min, Math.round(height)));
}

/** Host-side storage key for the last height a canvas set on this device. */
export function canvasHeightKey(
  environmentId: string,
  rootThreadId: string,
  canvasId: string,
): string {
  return `t3code:canvas-height:${environmentId}:${rootThreadId}:${canvasId}`;
}

/** A stored height back to pixels; null when absent or not a valid height. */
export function readStoredCanvasHeight(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const height = Number(raw);
  return height >= CANVAS_HEIGHT.min && height <= CANVAS_HEIGHT.max ? height : null;
}

/** An http(s) URL on one of Brad's known hosts, normalized; null otherwise. */
export function allowedUrl(url: string, knownHosts: ReadonlySet<string>): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  return knownHosts.has(parsed.host.toLowerCase()) ? parsed.href : null;
}

/** An issue page (`/owner/repo/issues/N`) on a known host. */
export function allowedIssueUrl(url: string, knownHosts: ReadonlySet<string>): string | null {
  const allowed = allowedUrl(url, knownHosts);
  return allowed && /^\/[^/]+\/[^/]+\/issues\/\d+\/?$/.test(new URL(allowed).pathname)
    ? allowed
    : null;
}

/** Hosts of URLs: Gitea web origins, issue and pull request links. */
export function hostsOf(urls: ReadonlyArray<string>): Set<string> {
  const hosts = new Set<string>();
  for (const url of urls) {
    try {
      hosts.add(new URL(url).host.toLowerCase());
    } catch {
      // Not a URL: contributes no host.
    }
  }
  return hosts;
}

export const RATE_LIMIT = { count: 5, windowMs: 10_000 } as const;

/** Resizes have their own, lighter budget so they never use up the actions' one. */
export const RESIZE_RATE_LIMIT = { count: 10, windowMs: 10_000 } as const;

/** Sliding-window limit per frame: true when one more intent is allowed now. */
export function takeRateSlot(
  history: number[],
  now: number,
  limit: { readonly count: number; readonly windowMs: number } = RATE_LIMIT,
): boolean {
  while (history.length > 0 && now - history[0]! >= limit.windowMs) history.shift();
  if (history.length >= limit.count) return false;
  history.push(now);
  return true;
}
