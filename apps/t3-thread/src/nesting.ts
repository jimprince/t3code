/**
 * Nesting and escalation helpers for orchestrating agents: where a created
 * worker lands, and how a parent answers a worker's pending question or
 * approval. Kept free of I/O so the rules are unit-tested.
 */

interface NestingThread {
  readonly id: string;
  readonly projectId: string;
  readonly parentThreadId?: string | null | undefined;
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt?: string | null | undefined;
}

export type CreateParentDecision =
  | { readonly parentThreadId: string; readonly reason: "explicit" | "caller" | "caller-parent" }
  | { readonly parentThreadId: null; readonly reason: string };

/**
 * Picks the thread a new worker nests under. By default a worker nests under
 * the calling thread; nesting is one level deep, so a worker started by an
 * already-nested thread joins that thread's parent. Callers in another project
 * or environment get a top-level worker with the reason reported.
 */
export function resolveCreateParent(input: {
  readonly explicitParentThreadId: string | null;
  readonly topLevel: boolean;
  /** False on servers that predate nesting; they would silently ignore a parent. */
  readonly serverSupportsNesting: boolean;
  readonly callerThreadId: string | null;
  readonly projectId: string;
  readonly threads: ReadonlyArray<NestingThread>;
}): CreateParentDecision {
  if (input.topLevel) return { parentThreadId: null, reason: "--top-level" };
  if (!input.serverSupportsNesting) {
    return {
      parentThreadId: null,
      reason: "this environment's server does not support nesting yet",
    };
  }
  if (input.explicitParentThreadId !== null) {
    return { parentThreadId: input.explicitParentThreadId, reason: "explicit" };
  }
  if (input.callerThreadId === null) return { parentThreadId: null, reason: "no calling thread" };
  const live = input.threads.filter((thread) => !thread.deletedAt && !thread.archivedAt);
  const caller = live.find((thread) => thread.id === input.callerThreadId);
  if (!caller) {
    return { parentThreadId: null, reason: "calling thread is in another environment" };
  }
  if (caller.projectId !== input.projectId) {
    return { parentThreadId: null, reason: "calling thread is in another project" };
  }
  if (!caller.parentThreadId) return { parentThreadId: caller.id, reason: "caller" };
  const grandparent = live.find((thread) => thread.id === caller.parentThreadId);
  return grandparent
    ? { parentThreadId: grandparent.id, reason: "caller-parent" }
    : { parentThreadId: caller.id, reason: "caller" };
}

export interface PendingQuestion {
  readonly id: string;
  readonly question: string;
  readonly options: ReadonlyArray<string>;
}

export type PendingRequest =
  | {
      readonly kind: "approval";
      readonly requestId: string;
      readonly createdAt: string;
      readonly detail: string | null;
    }
  | {
      readonly kind: "user-input";
      readonly requestId: string;
      readonly createdAt: string;
      readonly questions: ReadonlyArray<PendingQuestion>;
    };

const STALE_FAILURE_FRAGMENTS = ["stale pending", "unknown pending"];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function parseQuestions(value: unknown): PendingQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const question = record(entry);
    if (!question || typeof question.id !== "string" || typeof question.question !== "string") {
      return [];
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          const label = record(option)?.label ?? option;
          return typeof label === "string" ? [label] : [];
        })
      : [];
    return [{ id: question.id, question: question.question, options }];
  });
}

/**
 * Open approvals and questions on a thread, oldest first. Mirrors the client
 * reduction: a request closes when resolved or when the provider reports it
 * stale (for example after a restart).
 */
export function findPendingRequests(activities: ReadonlyArray<unknown>): PendingRequest[] {
  const open = new Map<string, PendingRequest>();
  const closed = new Set<string>();
  for (const entry of activities) {
    const activity = record(entry);
    const kind = activity?.kind;
    const createdAt = activity?.createdAt;
    if (typeof kind !== "string" || typeof createdAt !== "string") continue;
    const payload = record(activity?.payload);
    const requestId = payload?.requestId;
    if (typeof requestId !== "string") continue;
    const key = `${kind.includes("user-input") ? "input" : "approval"}:${requestId}`;
    const staleFailure =
      kind.endsWith(".respond.failed") &&
      typeof payload?.detail === "string" &&
      STALE_FAILURE_FRAGMENTS.some((fragment) =>
        (payload.detail as string).toLowerCase().includes(fragment),
      );
    if (kind === "approval.resolved" || kind === "user-input.resolved" || staleFailure) {
      closed.add(key);
      open.delete(key);
      continue;
    }
    if (closed.has(key)) continue;
    if (
      kind === "approval.requested" &&
      payload?.requestType !== "tool_user_input" &&
      payload?.requestType !== "auth_tokens_refresh"
    ) {
      open.set(key, {
        kind: "approval",
        requestId,
        createdAt,
        detail: typeof payload?.detail === "string" ? payload.detail : null,
      });
    } else if (kind === "user-input.requested") {
      const questions = parseQuestions(payload?.questions);
      if (questions.length > 0) {
        open.set(key, { kind: "user-input", requestId, createdAt, questions });
      }
    }
  }
  return [...open.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * Maps `answer` CLI input onto question ids. A single question takes the
 * free text; several questions need `--question <id>=<text>` for each one.
 */
export function buildUserInputAnswers(input: {
  readonly questions: ReadonlyArray<PendingQuestion>;
  readonly text: string;
  readonly pairs: ReadonlyArray<string>;
}): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const pair of input.pairs) {
    const separator = pair.indexOf("=");
    const id = separator > 0 ? pair.slice(0, separator) : "";
    if (!input.questions.some((question) => question.id === id)) {
      throw new Error(`Unknown question id in '${pair}'. Use --question <id>=<answer>.`);
    }
    answers[id] = pair.slice(separator + 1).trim();
  }
  const text = input.text.trim();
  const unanswered = input.questions.filter((question) => answers[question.id] === undefined);
  if (text && unanswered.length === 1) answers[unanswered[0]!.id] = text;
  const missing = input.questions.filter((question) => !answers[question.id]);
  if (missing.length > 0) {
    const list = missing.map((question) => `${question.id}: ${question.question}`).join("; ");
    throw new Error(
      `Answer every question (${list}). Pass free text for a single question, or --question <id>=<answer> for each.`,
    );
  }
  return answers;
}
