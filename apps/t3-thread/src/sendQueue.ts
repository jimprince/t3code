import * as NodeCrypto from "node:crypto";

import {
  loadState,
  nextQueuedSendSequence,
  requireEnvironment,
  updateState,
  upsertQueuedSend,
} from "./state.js";
import { classifyThread } from "./status.js";
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
 * boundary. Messages are never coalesced: two operator sends are two intents, and
 * concatenating them would silently change what the worker was asked to do.
 *
 * Retires when a paired server advertises upstream's `deliveryMode: "after-current"`
 * turn-start contract; `send` then forwards the flag instead of holding anything.
 */

/** How many dispatch attempts a queued send gets before it is marked undeliverable. */
export const MAX_DISPATCH_ATTEMPTS = 5;

/** A claim older than this is assumed to belong to a watcher that died mid-dispatch. */
const DISPATCH_CLAIM_TIMEOUT_MS = 120_000;

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
  queuedDuringTurnId: string | null;
  now?: () => string;
}): Promise<SavedQueuedSend> {
  const now = (input.now ?? nowIso)();

  return updateState(async (state) => {
    const queued: SavedQueuedSend = {
      id: NodeCrypto.randomUUID(),
      sequence: nextQueuedSendSequence(state.queuedSends),
      threadId: input.threadId,
      agentName: input.agentName,
      environment: input.environment,
      text: input.text,
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

    return {
      state: { ...state, queuedSends: upsertQueuedSend(state.queuedSends, queued) },
      result: queued,
    };
  });
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

/**
 * One drain pass. Dispatches at most one queued send per thread, because dispatching
 * starts a turn and the rest of that thread's queue must wait for the next boundary.
 */
export async function drainQueuedSends(options: {
  clientFactory: QueueClientFactory;
  env?: string;
  now?: () => string;
  maxAttempts?: number;
}): Promise<SavedQueuedSend[]> {
  const now = options.now ?? nowIso;
  const maxAttempts = options.maxAttempts ?? MAX_DISPATCH_ATTEMPTS;
  const state = await loadState();
  const heads = nextPerThread(state, options.env, Date.parse(now()));
  const settled: SavedQueuedSend[] = [];

  for (const head of heads) {
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
      continue;
    }

    const client = options.clientFactory(environment);

    let thread: OrchestrationThread;
    try {
      thread = await client.findThread(head.threadId);
    } catch (error) {
      // The thread may just be unreachable right now; keep the send queued and
      // retry until the attempt budget is spent.
      const failed = await recordAttemptFailure({
        queued: head,
        attemptedAt,
        maxAttempts,
        error: error instanceof Error ? error.message : String(error),
      });
      if (failed) settled.push(failed);
      continue;
    }

    if (thread.archivedAt || thread.deletedAt) {
      settled.push(
        ...(await retireQueueForThread({
          threadId: head.threadId,
          reason: `Thread '${head.threadId}' is archived; queued sends were dropped.`,
          now: attemptedAt,
        })),
      );
      continue;
    }

    if (IN_FLIGHT_STATES.has(classifyThread(thread).state)) {
      // Not a turn boundary yet. Leave the record untouched so its attempt budget
      // is only spent on real dispatch failures.
      continue;
    }

    const claimed = await claimQueuedSend(head, attemptedAt);
    if (!claimed) continue;

    let result: SavedQueuedSend;
    try {
      await client.sendMessage({
        threadId: claimed.threadId,
        text: claimed.text,
        queueWhileRunning: false,
      });
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
  }

  return settled;
}

async function recordAttemptFailure(input: {
  queued: SavedQueuedSend;
  attemptedAt: string;
  maxAttempts: number;
  error: string;
}): Promise<SavedQueuedSend | null> {
  return updateState(async (state) => {
    const current = state.queuedSends.find((candidate) => candidate.id === input.queued.id) ?? null;
    if (!current || !OPEN_STATUSES.has(current.status)) {
      return { state, result: null };
    }

    const attempts = current.attempts + 1;
    const next: SavedQueuedSend = {
      ...current,
      status: attempts >= input.maxAttempts ? "undeliverable" : "queued",
      attempts,
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
