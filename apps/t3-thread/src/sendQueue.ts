import * as NodeCrypto from "node:crypto";

import type { MessageOrigin } from "@t3tools/shared/messageOrigin";

import {
  loadState,
  nextQueuedSendSequence,
  requireEnvironment,
  updateState,
  upsertQueuedSend,
} from "./state.js";
import { classifyThread } from "./status.js";
import { threadQuotaBlock } from "./quota.js";
import type { OrchestrationThread, SavedEnvironment, SavedQueuedSend, StateFile } from "./types.js";

/**
 * Durable queue for sends that arrived while their target thread was mid-turn.
 *
 * `t3-thread send` exits immediately, so the queue lives in the same lock-protected
 * `state.json` that already holds environments, agents, subscriptions, and
 * notifications. The existing watcher drains it: no second broker, and the queue
 * survives CLI exit, watcher exit, machine sleep, and reboot.
 *
 * Ordering is FIFO by `sequence` within a thread, one dispatched message per turn
 * boundary. Messages are never merged: two operator sends are two intents, and
 * concatenating them would silently change what the worker was asked to do. A sender
 * may instead mark a recurring status note with a coalesce key, so a newer note from
 * the same sender replaces its still-waiting predecessor rather than queueing behind
 * it; without a key nothing is ever dropped.
 *
 * Retires when a paired server advertises upstream's `deliveryMode: "after-current"`
 * turn-start contract; `send` then forwards the flag instead of holding anything.
 */

/** How many dispatch attempts a queued send gets before it is marked undeliverable. */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** A claim older than this is assumed to belong to a watcher that died mid-dispatch. */
const DISPATCH_CLAIM_TIMEOUT_MS = 120_000;

/** Longest a drain waits on one environment read before treating it as unreachable. */
const THREAD_READ_TIMEOUT_MS = 30_000;

/** Shorter than the claim timeout, so a hung dispatch fails before its claim is taken over. */
const DISPATCH_TIMEOUT_MS = 60_000;

/** Heads are independent threads, so a pass reads and dispatches them in parallel. */
const DRAIN_CONCURRENCY = 8;

/** Thread states that mean the turn boundary has not arrived yet. */
const IN_FLIGHT_STATES = new Set(["running", "starting"]);

/** Statuses that still require a drain pass. */
const OPEN_STATUSES = new Set<SavedQueuedSend["status"]>(["queued", "dispatching"]);

export interface QueueClient {
  findThread(threadId: string): Promise<OrchestrationThread>;
  sendMessage(input: {
    threadId: string;
    text: string;
    allowWhileRunning?: boolean;
    queueWhileRunning?: boolean;
    origin?: MessageOrigin | null;
  }): Promise<unknown>;
}

export type QueueClientFactory = (environment: SavedEnvironment) => QueueClient;

function nowIso(): string {
  return new Date().toISOString();
}

/** Accept a send that cannot be dispatched yet and persist it before returning. */
export async function enqueueSend(input: {
  threadId: string;
  agentName: string | null;
  environment: string;
  text: string;
  origin?: MessageOrigin | null;
  coalesceKey?: string | null;
  queuedDuringTurnId: string | null;
  now?: () => string;
}): Promise<{ queued: SavedQueuedSend; superseded: SavedQueuedSend[] }> {
  const now = (input.now ?? nowIso)();

  return updateState(async (state) => {
    const queued: SavedQueuedSend = {
      id: NodeCrypto.randomUUID(),
      sequence: nextQueuedSendSequence(state.queuedSends),
      threadId: input.threadId,
      agentName: input.agentName,
      environment: input.environment,
      text: input.text,
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.coalesceKey ? { coalesceKey: input.coalesceKey } : {}),
      status: "queued",
      queuedDuringTurnId: input.queuedDuringTurnId,
      attempts: 0,
      queuedAt: now,
      updatedAt: now,
      dispatchedAt: null,
      lastAttemptedAt: null,
      lastError: null,
      dispatchClaimId: null,
    };

    // A claimed (`dispatching`) send is already on its way, so only waiting ones are replaced.
    const superseded = input.coalesceKey
      ? state.queuedSends
          .filter(
            (candidate) =>
              candidate.status === "queued" &&
              candidate.coalesceKey === input.coalesceKey &&
              candidate.threadId === queued.threadId &&
              candidate.environment === queued.environment &&
              senderOf(candidate) === senderOf(queued),
          )
          .map((candidate): SavedQueuedSend => ({
            ...candidate,
            status: "cancelled",
            updatedAt: now,
            lastError: `Superseded by ${queued.id}.`,
          }))
      : [];

    const queuedSends = [...superseded, queued].reduce(
      (all, record) => upsertQueuedSend(all, record),
      state.queuedSends,
    );
    return { state: { ...state, queuedSends }, result: { queued, superseded } };
  });
}

/** Stable identity of whoever queued a send; null for an operator at the keyboard. */
function senderOf(queued: SavedQueuedSend): string | null {
  return queued.origin?.fromThreadId ?? null;
}

export interface QueueSummary {
  open: number;
  byTarget: Array<{
    threadId: string;
    agentName: string | null;
    open: number;
    bySender: Array<{ sender: string | null; name: string | null; open: number }>;
    oldestAgeSeconds: number;
  }>;
}

/** Open sends grouped by target and sender, so a flood is visible before it drains. */
export function summarizeQueuedSends(
  state: StateFile,
  filter: { env?: string; threadId?: string } = {},
  nowMs: number = Date.now(),
): QueueSummary {
  const targets = new Map<string, QueueSummary["byTarget"][number]>();
  const open = listQueuedSends(state, { ...filter, openOnly: true });
  for (const queued of open) {
    const key = JSON.stringify([queued.environment, queued.threadId]);
    const target = targets.get(key) ?? {
      threadId: queued.threadId,
      agentName: queued.agentName,
      open: 0,
      bySender: [],
      oldestAgeSeconds: 0,
    };
    target.open += 1;
    const sender = senderOf(queued);
    const entry = target.bySender.find((candidate) => candidate.sender === sender);
    if (entry) entry.open += 1;
    else target.bySender.push({ sender, name: queued.origin?.fromName ?? null, open: 1 });
    target.oldestAgeSeconds = Math.max(
      target.oldestAgeSeconds,
      Math.max(0, Math.floor((nowMs - Date.parse(queued.queuedAt)) / 1000)),
    );
    targets.set(key, target);
  }
  return {
    open: open.length,
    byTarget: [...targets.values()]
      .map((target) => ({
        ...target,
        bySender: target.bySender.sort((left, right) => right.open - left.open),
      }))
      .sort((left, right) => right.open - left.open),
  };
}

export function listQueuedSends(
  state: StateFile,
  filter: { env?: string; threadId?: string; openOnly?: boolean } = {},
): SavedQueuedSend[] {
  return state.queuedSends
    .filter((queued) => {
      if (filter.env && queued.environment !== filter.env) return false;
      if (filter.threadId && queued.threadId !== filter.threadId) return false;
      if (filter.openOnly && !OPEN_STATUSES.has(queued.status)) return false;
      return true;
    })
    .sort((left, right) => left.sequence - right.sequence);
}

/** Operator escape hatch: drop a queued send before it reaches the worker. */
export async function cancelQueuedSend(
  id: string,
  options: { now?: () => string } = {},
): Promise<SavedQueuedSend> {
  const now = (options.now ?? nowIso)();

  return updateState(async (state) => {
    const current = state.queuedSends.find((queued) => queued.id === id);
    if (!current) {
      throw new Error(`Unknown queued send '${id}'.`);
    }
    if (!OPEN_STATUSES.has(current.status)) {
      throw new Error(`Queued send '${id}' is already ${current.status} and cannot be cancelled.`);
    }

    const cancelled: SavedQueuedSend = { ...current, status: "cancelled", updatedAt: now };
    return {
      state: { ...state, queuedSends: upsertQueuedSend(state.queuedSends, cancelled) },
      result: cancelled,
    };
  });
}

/**
 * True when the queue still needs the watcher. Terminal records (dispatched,
 * cancelled, undeliverable) never keep the watcher alive.
 */
export function hasQueuedWork(state: StateFile, options: { env?: string } = {}): boolean {
  return listQueuedSends(state, { ...options, openOnly: true }).length > 0;
}

function isClaimStale(queued: SavedQueuedSend, nowMs: number): boolean {
  if (queued.status !== "dispatching") return false;
  const claimedAtMs = Date.parse(queued.lastAttemptedAt ?? queued.updatedAt);
  if (Number.isNaN(claimedAtMs)) return true;
  return nowMs - claimedAtMs >= DISPATCH_CLAIM_TIMEOUT_MS;
}

/** Head-of-line queued send per thread, in FIFO order, skipping live claims. */
function nextPerThread(
  state: StateFile,
  env: string | undefined,
  nowMs: number,
): SavedQueuedSend[] {
  const heads = new Map<string, SavedQueuedSend>();
  const seen = new Set<string>();
  for (const queued of listQueuedSends(state, { env, openOnly: true })) {
    const key = JSON.stringify([queued.environment, queued.threadId]);
    if (seen.has(key)) continue;
    // A live head claim blocks the rest of its queue, even in another watcher.
    seen.add(key);
    if (queued.status === "dispatching" && !isClaimStale(queued, nowMs)) continue;
    heads.set(key, queued);
  }
  return [...heads.values()];
}

async function claimQueuedSend(
  queued: SavedQueuedSend,
  claimedAt: string,
): Promise<SavedQueuedSend | null> {
  return updateState(async (state) => {
    const current = state.queuedSends.find((candidate) => candidate.id === queued.id) ?? null;
    if (!current || current.dispatchClaimId !== queued.dispatchClaimId) {
      return { state, result: null };
    }
    if (!OPEN_STATUSES.has(current.status)) {
      return { state, result: null };
    }

    const claimed: SavedQueuedSend = {
      ...current,
      status: "dispatching",
      updatedAt: claimedAt,
      lastAttemptedAt: claimedAt,
      dispatchClaimId: NodeCrypto.randomUUID(),
    };
    return {
      state: { ...state, queuedSends: upsertQueuedSend(state.queuedSends, claimed) },
      result: claimed,
    };
  });
}

async function finalizeQueuedSend(
  result: SavedQueuedSend,
  claimId: string | null,
): Promise<SavedQueuedSend | null> {
  return updateState(async (state) => {
    const current = state.queuedSends.find((candidate) => candidate.id === result.id) ?? null;
    if (!current || current.dispatchClaimId !== claimId) {
      return { state, result: null };
    }

    const finalized: SavedQueuedSend = { ...result, dispatchClaimId: null };
    return {
      state: { ...state, queuedSends: upsertQueuedSend(state.queuedSends, finalized) },
      result: finalized,
    };
  });
}

/** Mark every open queued send for a thread terminal with the same reason. */
async function retireQueueForThread(input: {
  threadId: string;
  reason: string;
  now: string;
}): Promise<SavedQueuedSend[]> {
  return updateState(async (state) => {
    const retired: SavedQueuedSend[] = [];
    let queuedSends = state.queuedSends;

    for (const queued of listQueuedSends(state, { threadId: input.threadId, openOnly: true })) {
      const next: SavedQueuedSend = {
        ...queued,
        status: "undeliverable",
        updatedAt: input.now,
        lastAttemptedAt: input.now,
        lastError: input.reason,
        dispatchClaimId: null,
      };
      queuedSends = upsertQueuedSend(queuedSends, next);
      retired.push(next);
    }

    return { state: { ...state, queuedSends }, result: retired };
  });
}

function withTimeout<T>(operation: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s.`)), ms);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

async function mapConcurrent<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) await run(items[next++]!);
    }),
  );
}

/**
 * One drain pass. Dispatches at most one queued send per thread, because dispatching
 * starts a turn and the rest of that thread's queue must wait for the next boundary.
 *
 * A pass is cheap and bounded: the watcher runs it on its own cadence, independent of
 * the much slower attention scan, so an idle target picks up its queue within one
 * poll interval instead of waiting for a full scan of every saved agent.
 */
export async function drainQueuedSends(options: {
  clientFactory: QueueClientFactory;
  env?: string;
  now?: () => string;
  maxAttempts?: number;
  readTimeoutMs?: number;
}): Promise<SavedQueuedSend[]> {
  const now = options.now ?? nowIso;
  const maxAttempts = options.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  const state = await loadState();
  const heads = nextPerThread(state, options.env, Date.parse(now()));
  const settled: SavedQueuedSend[] = [];

  await mapConcurrent(heads, DRAIN_CONCURRENCY, async (head) => {
    const attemptedAt = now();

    let environment: SavedEnvironment;
    try {
      environment = requireEnvironment(state, head.environment);
    } catch (error) {
      settled.push(
        ...(await retireQueueForThread({
          threadId: head.threadId,
          reason: error instanceof Error ? error.message : String(error),
          now: attemptedAt,
        })),
      );
      return;
    }

    const client = options.clientFactory(environment);

    let thread: OrchestrationThread;
    try {
      thread = await withTimeout(
        client.findThread(head.threadId),
        options.readTimeoutMs ?? THREAD_READ_TIMEOUT_MS,
        "Reading the target thread",
      );
    } catch (error) {
      // An unreachable server (a restart, a sleeping laptop) says nothing about the
      // message, so it must not spend the attempt budget: five failed passes are
      // seconds apart and would drop the whole queue during an ordinary restart.
      const noted = await recordUnreachable({
        queued: head,
        attemptedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      if (noted) settled.push(noted);
      return;
    }

    if (thread.archivedAt || thread.deletedAt) {
      settled.push(
        ...(await retireQueueForThread({
          threadId: head.threadId,
          reason: `Thread '${head.threadId}' is archived; queued sends were dropped.`,
          now: attemptedAt,
        })),
      );
      return;
    }

    const quota = threadQuotaBlock(thread);
    const notification = head.origin
      ? head.origin.source === "worker-notification"
      : /^(?:HomeNetwork|T3) orchestrator notification:/.test(head.text);
    if (
      (notification && thread.settledOverride === "settled") ||
      (/^(?:HomeNetwork|T3) orchestrator notification:/.test(head.text) &&
        quota &&
        (quota.resetsAt === null || quota.resetsAt > Date.parse(attemptedAt)))
    ) {
      return;
    }

    if (IN_FLIGHT_STATES.has(classifyThread(thread).state)) {
      // Not a turn boundary yet. Leave the record untouched so its attempt budget
      // is only spent on real dispatch failures.
      return;
    }

    const claimed = await claimQueuedSend(head, attemptedAt);
    if (!claimed) return;

    let result: SavedQueuedSend;
    try {
      await withTimeout(
        client.sendMessage({
          threadId: claimed.threadId,
          text: claimed.text,
          origin: claimed.origin ?? null,
          queueWhileRunning: false,
        }),
        DISPATCH_TIMEOUT_MS,
        "Dispatching the queued send",
      );
      result = {
        ...claimed,
        status: "dispatched",
        updatedAt: attemptedAt,
        dispatchedAt: attemptedAt,
        lastError: null,
      };
    } catch (error) {
      const attempts = claimed.attempts + 1;
      result = {
        ...claimed,
        status: attempts >= maxAttempts ? "undeliverable" : "queued",
        attempts,
        updatedAt: attemptedAt,
        lastError: error instanceof Error ? error.message : String(error),
      };
    }

    const persisted = await finalizeQueuedSend(result, claimed.dispatchClaimId);
    if (persisted) settled.push(persisted);
  });

  return settled.sort((left, right) => left.sequence - right.sequence);
}

/** Record why a head could not be read, without spending its attempt budget. */
async function recordUnreachable(input: {
  queued: SavedQueuedSend;
  attemptedAt: string;
  error: string;
}): Promise<SavedQueuedSend | null> {
  return updateState(async (state) => {
    const current = state.queuedSends.find((candidate) => candidate.id === input.queued.id) ?? null;
    // Skip the rewrite while the reason is unchanged: state.json is large and every
    // pass would otherwise rewrite it for each unreachable head.
    if (!current || !OPEN_STATUSES.has(current.status) || current.lastError === input.error) {
      return { state, result: null };
    }

    const next: SavedQueuedSend = {
      ...current,
      status: "queued",
      updatedAt: input.attemptedAt,
      lastAttemptedAt: input.attemptedAt,
      lastError: input.error,
      dispatchClaimId: null,
    };

    return {
      state: { ...state, queuedSends: upsertQueuedSend(state.queuedSends, next) },
      result: next,
    };
  });
}

/**
 * Drain every `intervalMs`, separately from the watcher's attention scan. The scan
 * reads every saved agent and takes minutes on a busy machine; chained behind it,
 * an idle target waited a whole scan before its queue moved.
 */
export function startQueueDrainLoop(options: {
  clientFactory: QueueClientFactory;
  env?: string;
  intervalMs: number;
  report?: (report: { queuedSendResults: SavedQueuedSend[] } | { drainError: string }) => void;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let wake: () => void = () => {};
  const loop = (async () => {
    while (!stopped) {
      try {
        const results = await drainQueuedSends(options);
        if (results.length > 0) options.report?.({ queuedSendResults: results });
      } catch (error) {
        // One failed pass must not end the loop; the next tick retries.
        options.report?.({ drainError: error instanceof Error ? error.message : String(error) });
      }
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, options.intervalMs).unref();
      });
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      wake();
      await loop;
    },
  };
}
