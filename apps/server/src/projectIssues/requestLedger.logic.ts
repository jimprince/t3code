import type { ProjectIssueRequestSource, ThreadId } from "@t3tools/contracts";
import { isPageAgentThreadId } from "@t3tools/contracts";

import type { RequestKind } from "../textGeneration/RequestItemsPrompt.ts";
import { formatRequestMarker } from "./projectIssues.logic.ts";

/** Labels the ledger puts on a request issue: `ask` plus one kind label. */
export const requestKindLabel = (kind: RequestKind) => `ask:${kind}`;

export const REQUEST_LABEL_COLORS: Record<string, string> = {
  ask: "#5b6ee1",
  "ask:question": "#3987e5",
  "ask:deliverable": "#199e70",
  "ask:plan": "#9085e9",
  "ask:change": "#d95926",
  "ask:test": "#c98500",
  "awaiting-release": "#9085e9",
  "needs-test": "#fab219",
};

const ORIGIN_CONTEXT_KIND = "t3-origin";
const WORKER_PREAMBLE = /^You are a T3 worker thread\b/;
const NUDGE =
  /^(ok(ay)?|k|yes|yep|yeah|no|nope|go|go ahead|do it|continue|proceed|thanks?|thank you|looks good|lgtm|sure|great|nice|now|status|done|approved?|ship it)[\s.!?]*$/i;

interface CaptureCandidate {
  readonly type: string;
  readonly threadId?: string;
  readonly message?: {
    readonly messageId: string;
    readonly role: string;
    readonly text: string;
    readonly context?: { readonly records?: ReadonlyArray<{ readonly kind?: string }> } | null;
  };
}

/**
 * The message Brad typed, when a dispatched command is one: a user turn start
 * from a UI client (web, desktop or mobile), not sent on a thread's behalf, not
 * a page agent conversation and not a worker brief. The CLI never reports a UI
 * surface, so agent-sent messages are excluded even without an origin record.
 */
export function capturableMessage(
  command: object,
  surface: string | undefined,
): { threadId: ThreadId; messageId: string; text: string } | null {
  const candidate = command as CaptureCandidate;
  const message = candidate.message;
  if (candidate.type !== "thread.turn.start" || !message || !candidate.threadId) return null;
  if (surface !== "web" && surface !== "desktop" && surface !== "mobile") return null;
  if (message.role !== "user" || isPageAgentThreadId(candidate.threadId)) return null;
  if (message.context?.records?.some((record) => record.kind === ORIGIN_CONTEXT_KIND)) return null;
  if (WORKER_PREAMBLE.test(message.text.trimStart())) return null;
  return {
    threadId: candidate.threadId as ThreadId,
    messageId: message.messageId,
    text: message.text,
  };
}

/** Short acknowledgements and nudges never carry a request; skip the model call. */
export function isObviouslyNotARequest(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length < 12 || NUDGE.test(trimmed);
}

/** Used when no model can split the message: the whole message is one request. */
export function fallbackRequestItem(text: string): {
  title: string;
  kind: RequestKind;
  excerpt: string;
} {
  const trimmed = text.trim();
  const firstSentence = /^[^\n]*?[.?!](?=\s|$)/.exec(trimmed)?.[0] ?? trimmed.split("\n")[0]!;
  return {
    title: clampTitle(firstSentence),
    kind: firstSentence.trim().endsWith("?") ? "question" : "deliverable",
    excerpt: trimmed,
  };
}

export function clampTitle(title: string): string {
  const oneLine = title.replace(/\s+/g, " ").trim();
  return oneLine.length <= 90 ? oneLine : `${oneLine.slice(0, 87).trimEnd()}...`;
}

/** Issue body: Brad's words, where he asked, and the hidden provenance marker. */
export function formatRequestIssueBody(input: {
  readonly excerpt: string;
  readonly kind: RequestKind;
  readonly threadTitle: string;
  readonly rootTitle: string | null;
  readonly source: ProjectIssueRequestSource;
}): string {
  const quoted = input.excerpt
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const where =
    input.rootTitle && input.source.rootThreadId !== input.source.threadId
      ? `**${input.threadTitle}** (under **${input.rootTitle}**)`
      : `**${input.threadTitle}**`;
  return [
    quoted,
    "",
    `Requested in ${where}. Kind: ${input.kind}. Settled only by the requester, from the project page.`,
    "",
    formatRequestMarker(input.source),
    "",
  ].join("\n");
}

/**
 * An agent's reference to a request: a number or `#N` in the project's tracker,
 * `owner/repo#N` on the same host, or a full issue URL on the tracker's host.
 */
export function parseRequestReference(
  reference: string,
  tracker: { readonly host: string; readonly repository: string },
): { repository: string; number: number } | null {
  const trimmed = reference.trim();
  const local = /^#?([1-9]\d*)$/.exec(trimmed);
  if (local) return { repository: tracker.repository, number: Number(local[1]) };
  const short = /^([\w.-]+\/[\w.-]+)#([1-9]\d*)$/.exec(trimmed);
  if (short) return { repository: short[1]!.toLowerCase(), number: Number(short[2]) };
  if (!URL.canParse(trimmed)) return null;
  const url = new URL(trimmed);
  const path = /^\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  return url.host.toLowerCase() === tracker.host && path
    ? { repository: path[1]!.toLowerCase(), number: Number(path[2]) }
    : null;
}
