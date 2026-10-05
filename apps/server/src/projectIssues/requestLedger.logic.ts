import type { ProjectIssue, ProjectIssueRequestSource, ThreadId } from "@t3tools/contracts";
import { isPageAgentThreadId } from "@t3tools/contracts";

import type { RequestCandidate, RequestKind } from "../textGeneration/RequestItemsPrompt.ts";
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
  "ask:bug": "#e5484d",
  "ask:feature": "#2f9e8f",
  "ask:maintenance": "#7d7d7d",
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

/** The progress line a stage change posts when the agent gave no text of its own. */
export function progressLineFor(
  status:
    | "pending"
    | "in-progress"
    | "needs-review"
    | "awaiting-release"
    | "needs-test"
    | undefined,
): string | null {
  switch (status) {
    case "in-progress":
      return "Progress: started";
    case "needs-review":
      return "Progress: ready for review";
    case "awaiting-release":
      return "Progress: built and handed over for the next release";
    case "pending":
      return "Progress: back to requested";
    default:
      return null;
  }
}

const MAX_REQUEST_CANDIDATES = 40;

/**
 * Open issues a chat message may continue, newest activity first: the issues
 * linked to its thread, then the project's other open requests (for dedupe).
 */
export function requestCandidates(
  issues: ReadonlyArray<ProjectIssue>,
  threadId: string,
): RequestCandidate[] {
  const open = issues
    .filter((issue) => issue.closedAt === null && issue.status !== "done")
    .filter((issue) => issue.status !== "archived")
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const inThread = open.filter((issue) => issue.linkedThreadIds.includes(threadId as ThreadId));
  const requests = open.filter(
    (issue) => issue.isRequest && !issue.linkedThreadIds.includes(threadId as ThreadId),
  );
  return [
    ...inThread.map((issue) => ({ number: issue.number, title: issue.title, inThread: true })),
    ...requests.map((issue) => ({ number: issue.number, title: issue.title, inThread: false })),
  ].slice(0, MAX_REQUEST_CANDIDATES);
}

export type RequestItemPlan =
  | { readonly action: "file" }
  | { readonly action: "comment"; readonly number: number }
  | { readonly action: "skip" };

/**
 * What one split item becomes. The New request box always files. A chat
 * message's question is conversation and is skipped; anything else continues
 * the open issue the split named (or, without a model, the thread's only linked
 * issue) as a comment; only genuinely new work becomes a new issue. Without a
 * model and without a single thread issue, a chat message files nothing.
 */
export function planRequestItem(
  item: { readonly kind: RequestKind; readonly existing?: number | null },
  context: {
    readonly explicit: boolean;
    readonly candidates: ReadonlyArray<RequestCandidate>;
    /** No model split the message: fall back to the thread's newest linked issue. */
    readonly unsplit: boolean;
  },
): RequestItemPlan {
  if (context.explicit) return { action: "file" };
  if (item.kind === "question") return { action: "skip" };
  const named = context.candidates.find((candidate) => candidate.number === item.existing);
  if (named) return { action: "comment", number: named.number };
  if (!context.unsplit) return { action: "file" };
  // Without a model the message's topic is unknown: it follows the thread's issue
  // only when the thread has exactly one, and otherwise stays conversation. An
  // orchestrator thread linked to many issues must not pile every message onto
  // whichever one changed last (seen on fork.26).
  const threadIssues = context.candidates.filter((candidate) => candidate.inThread);
  return threadIssues.length === 1
    ? { action: "comment", number: threadIssues[0]!.number }
    : { action: "skip" };
}

const FOLLOW_UP_MARKER = "t3-request-followup";

/** A follow-up Brad sent in a thread, recorded on the issue it continues. */
export function formatFollowUpComment(input: {
  readonly excerpt: string;
  readonly threadTitle: string;
  readonly messageId: string;
  readonly item: number;
}): string {
  const quoted = input.excerpt
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const marker = JSON.stringify({ messageId: input.messageId, item: input.item });
  return [
    `Follow-up from Brad in **${input.threadTitle}**:`,
    "",
    quoted,
    "",
    `<!-- ${FOLLOW_UP_MARKER} ${marker} -->`,
    "",
  ].join("\n");
}

interface AnswerMessage {
  readonly messageId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly isStreaming: boolean;
  readonly createdAt: string;
}

/**
 * The thread's reply to one request's message: the last finished assistant message
 * of the turn that message started (or, without a turn id, before the next user
 * message). Null while the reply is missing or still streaming, so each question
 * shows its own answer and never another one's.
 */
export function answerToMessage(
  messages: ReadonlyArray<AnswerMessage>,
  messageId: string,
): { text: string; askedAt: string; answeredAt: string } | null {
  const index = messages.findIndex((message) => message.messageId === messageId);
  if (index < 0) return null;
  const asked = messages[index]!;
  const after = messages.slice(index + 1);
  const span =
    asked.turnId === null
      ? after.slice(
          0,
          (() => {
            const next = after.findIndex((message) => message.role === "user");
            return next < 0 ? after.length : next;
          })(),
        )
      : after.filter((message) => message.turnId === asked.turnId);
  const replies = span.filter((message) => message.role === "assistant");
  if (replies.length === 0 || replies.some((message) => message.isStreaming)) return null;
  const reply = replies.findLast((message) => message.text.trim().length > 0);
  return reply
    ? { text: reply.text.trim(), askedAt: asked.createdAt, answeredAt: reply.createdAt }
    : null;
}
