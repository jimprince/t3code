import * as NodeCrypto from "node:crypto";

import { RemoteEnvironmentClient } from "./client.js";
import { buildAgentOverview, needsAttention } from "./monitor.js";
import {
  buildNotificationMessage,
  buildNotificationRecord,
  MAX_DELIVERY_ATTEMPTS,
  mergeDetectedNotification,
  nextAttemptAt,
  TERMINAL_NOTIFICATION_STATUSES,
} from "./notifications.js";
import { loadState, requireEnvironment, updateState, upsertNotification } from "./state.js";
import { classifyThread } from "./status.js";
import { isProcessRunning } from "./watcher-process.js";
import type {
  OrchestrationThread,
  SavedEnvironment,
  SavedNotification,
  StateFile,
} from "./types.js";

const DELIVERY_CLAIM_TIMEOUT_MS = 60_000;

/** How long to wait before re-offering a notification to a recipient that is mid-turn. */
const BUSY_RECIPIENT_RETRY_MS = 30_000;

/**
 * When this process started. A claim stamped before that cannot be ours, even if
 * it records our pid, because the kernel recycles pids across watcher restarts.
 */
const PROCESS_STARTED_AT_MS = Date.now();

export interface WatchClient {
  findThread(threadId: string): Promise<OrchestrationThread>;
  /** Result is unused here; `RemoteEnvironmentClient.sendMessage` reports dispatch vs queue. */
  sendMessage(input: { threadId: string; text: string }): Promise<unknown>;
}

export type WatchClientFactory = (environment: SavedEnvironment) => WatchClient;

function createWatchClient(environment: SavedEnvironment): WatchClient {
  return new RemoteEnvironmentClient(environment);
}

function nowIso(): string {
  return new Date().toISOString();
}

function matchesEnvFilter(notification: SavedNotification, env?: string): boolean {
  return !env || notification.sourceEnvironment === env;
}

/**
 * Whether a claimed notification may be taken over.
 *
 * Ownership, not elapsed time, is the primary signal. A wall-clock timeout alone
 * makes the watcher steal its own in-flight claim after the machine sleeps, and
 * the message is then delivered twice. A claim held by a live process is only
 * reclaimed when that process is not this watcher and has also gone quiet past
 * the timeout, which covers a wedged watcher or a pid reused after a reboot.
 */
function isClaimStale(
  notification: SavedNotification,
  nowMs: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean = isProcessRunning,
  selfPid: number = process.pid,
  startedAtMs: number = PROCESS_STARTED_AT_MS,
): boolean {
  if (notification.status !== "delivering") {
    return false;
  }

  const claimedAt = notification.lastAttemptedAt ?? notification.updatedAt;
  const claimedAtMs = Date.parse(claimedAt);
  if (Number.isNaN(claimedAtMs)) {
    return true;
  }

  const owner = notification.deliveryClaimPid ?? null;
  if (owner !== null) {
    if (owner === selfPid && claimedAtMs >= startedAtMs) {
      return false;
    }
    if (owner !== selfPid && !isAlive(owner)) {
      return true;
    }
    if (owner === selfPid) {
      // Our pid, but stamped before we started: a recycled pid from a dead watcher.
      return true;
    }
  }

  return nowMs - claimedAtMs >= timeoutMs;
}

function isAttemptDue(notification: SavedNotification, nowMs: number): boolean {
  if (!notification.nextAttemptAt) {
    return true;
  }
  const dueMs = Date.parse(notification.nextAttemptAt);
  return Number.isNaN(dueMs) || dueMs <= nowMs;
}

function credentialExpiry(environment: SavedEnvironment, nowMs: number): string | null {
  const expiresAtMs = Date.parse(environment.expiresAt);
  if (Number.isNaN(expiresAtMs) || expiresAtMs > nowMs) {
    return null;
  }
  return environment.expiresAt;
}

export async function scanAttentionNotifications(
  state: StateFile,
  options: {
    env?: string;
    clientFactory?: WatchClientFactory;
    now?: () => string;
  } = {},
): Promise<SavedNotification[]> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const now = options.now ?? nowIso;
  const scopedAgents = options.env
    ? state.agents.filter((savedAgent) => savedAgent.environment === options.env)
    : state.agents;
  const scanned: SavedNotification[] = [];

  for (const sourceAgent of scopedAgents) {
    const sourceEnvironment = requireEnvironment(state, sourceAgent.environment);
    const sourceClient = clientFactory(sourceEnvironment);
    let sourceThread: OrchestrationThread;
    try {
      sourceThread = await sourceClient.findThread(sourceAgent.threadId);
    } catch {
      // Saved agents/subscriptions can outlive remote threads. A stale source
      // should not prevent detection for every other watched route.
      continue;
    }
    const overview = buildAgentOverview(sourceAgent, sourceThread);
    if (!needsAttention(overview)) {
      continue;
    }

    const subscriptions = state.subscriptions.filter(
      (subscription) => subscription.sourceThreadId === sourceAgent.threadId,
    );
    if (subscriptions.length === 0) {
      continue;
    }

    for (const subscription of subscriptions) {
      // Attention for the turn that was already current when the subscriber
      // signed up is old news to it; only a later turn is a new transition.
      if (
        subscription.baselineTurnId &&
        (sourceThread.latestTurn?.turnId ?? null) === subscription.baselineTurnId
      ) {
        continue;
      }
      const existing =
        state.notifications.find((notification) => {
          return (
            notification.subscriberThreadId === subscription.subscriberThreadId &&
            notification.sourceThreadId === subscription.sourceThreadId &&
            notification.latestAssistantMessageId === overview.latestAssistantMessageId &&
            notification.latestTurnId === (sourceThread.latestTurn?.turnId ?? null) &&
            notification.sourceState === overview.state
          );
        }) ?? null;

      scanned.push(
        buildNotificationRecord({
          sourceAgent,
          subscription,
          overview,
          thread: sourceThread,
          now: now(),
          existing,
        }),
      );
    }
  }

  return scanned;
}

const UNDELIVERED_STATUSES = new Set(["pending", "delivering", "delivery-failed"]);
const IN_FLIGHT_SOURCE_STATES = new Set(["running", "starting", "ready"]);

/** Undelivered statuses that a newer event on the same route may overtake. */
const SUPERSEDABLE_STATUSES = new Set(["pending", "delivery-failed"]);

/**
 * Retire every undelivered event on `latest`'s route that `latest` has overtaken.
 *
 * The source moved on before the earlier event reached the subscriber, so the
 * earlier event no longer describes anything the subscriber can act on. Each
 * delivery starts a turn on the recipient; draining a backlog one event per
 * pass would spend several turns re-announcing states that are already stale.
 * A claimed (`delivering`) event is left alone: its watcher owns it.
 */
function supersedeOvertakenNotifications(
  notifications: SavedNotification[],
  latest: SavedNotification,
  now: string,
): SavedNotification[] {
  return notifications.map((candidate) => {
    if (
      candidate.eventKey === latest.eventKey ||
      candidate.subscriberThreadId !== latest.subscriberThreadId ||
      candidate.sourceThreadId !== latest.sourceThreadId ||
      !SUPERSEDABLE_STATUSES.has(candidate.status)
    ) {
      return candidate;
    }
    return {
      ...candidate,
      status: "superseded",
      updatedAt: now,
      lastError: `Superseded by newer event ${latest.eventKey}.`,
      nextAttemptAt: null,
    };
  });
}

/**
 * True when the watcher still has something to do: any undelivered notification, or any
 * subscribed source thread that is still actively in flight. Used as the idle-exit guard
 * so the watcher never quits while a watched thread could still produce a completion.
 * Unreachable source threads are treated as not-in-flight (so an unpaired/dead env lets
 * the watcher idle out instead of spinning forever).
 */
export async function hasActiveWork(
  options: { env?: string; clientFactory?: WatchClientFactory } = {},
): Promise<boolean> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const state = await loadState();

  const undelivered = state.notifications.some(
    (notification) =>
      UNDELIVERED_STATUSES.has(notification.status) && matchesEnvFilter(notification, options.env),
  );
  if (undelivered) {
    return true;
  }

  const subscribedSourceThreadIds = new Set(
    state.subscriptions.map((subscription) => subscription.sourceThreadId),
  );
  if (subscribedSourceThreadIds.size === 0) {
    return false;
  }

  for (const agent of state.agents) {
    if (!subscribedSourceThreadIds.has(agent.threadId)) {
      continue;
    }
    if (options.env && agent.environment !== options.env) {
      continue;
    }
    try {
      const environment = requireEnvironment(state, agent.environment);
      const thread = await clientFactory(environment).findThread(agent.threadId);
      if (IN_FLIGHT_SOURCE_STATES.has(classifyThread(thread).state)) {
        return true;
      }
    } catch {
      // Unreachable env/thread → treat as not in flight.
    }
  }

  return false;
}

export async function detectAttentionEvents(
  options: {
    env?: string;
    clientFactory?: WatchClientFactory;
    now?: () => string;
  } = {},
): Promise<SavedNotification[]> {
  const state = await loadState();
  const scanned = await scanAttentionNotifications(state, options);
  if (scanned.length === 0) {
    return [];
  }

  return updateState(async (currentState) => {
    const persisted: SavedNotification[] = [];
    let notifications = currentState.notifications;

    for (const notification of scanned) {
      const existing =
        notifications.find((candidate) => candidate.eventKey === notification.eventKey) ?? null;
      const merged = mergeDetectedNotification(existing, notification);
      notifications = upsertNotification(notifications, merged);
      if (!existing) {
        notifications = supersedeOvertakenNotifications(notifications, merged, merged.updatedAt);
      }
      persisted.push(merged);
    }

    return {
      state: {
        ...currentState,
        notifications,
      },
      result: persisted,
    };
  });
}

export async function claimPendingNotifications(
  options: {
    env?: string;
    now?: () => string;
    claimTimeoutMs?: number;
  } = {},
): Promise<SavedNotification[]> {
  const now = options.now ?? nowIso;
  const claimTimeoutMs = options.claimTimeoutMs ?? DELIVERY_CLAIM_TIMEOUT_MS;
  const claimedAt = now();
  const claimedAtMs = Date.parse(claimedAt);

  return updateState(async (state) => {
    const claimed: SavedNotification[] = [];
    // Oldest event first, and at most one per recipient: delivering a
    // notification starts a turn on the recipient, so a second one in the same
    // pass would only find it busy. Ordering is by creation, then event key, so
    // two watcher passes over the same state make the same choice.
    const claimable = [...state.notifications]
      .filter((notification) => matchesEnvFilter(notification, options.env))
      .filter((notification) => {
        if (TERMINAL_NOTIFICATION_STATUSES.has(notification.status)) {
          return false;
        }
        if (notification.status === "delivering") {
          return isClaimStale(notification, claimedAtMs, claimTimeoutMs);
        }
        return isAttemptDue(notification, claimedAtMs);
      })
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.eventKey.localeCompare(right.eventKey),
      );

    const claimedSubscribers = new Set<string>();
    for (const notification of claimable) {
      if (claimedSubscribers.has(notification.subscriberThreadId)) {
        continue;
      }
      claimedSubscribers.add(notification.subscriberThreadId);
      claimed.push({
        ...notification,
        status: "delivering",
        updatedAt: claimedAt,
        lastAttemptedAt: claimedAt,
        lastError: null,
        deliveryClaimId: NodeCrypto.randomUUID(),
        deliveryClaimPid: process.pid,
      });
    }

    let notifications = state.notifications;
    for (const notification of claimed) {
      notifications = upsertNotification(notifications, notification);
    }

    return {
      state: {
        ...state,
        notifications,
      },
      result: claimed,
    };
  });
}

async function finalizeNotificationAttempt(input: {
  notification: SavedNotification;
  claimId: string | null;
}): Promise<SavedNotification | null> {
  return updateState(async (state) => {
    const current =
      state.notifications.find((candidate) => candidate.eventKey === input.notification.eventKey) ??
      null;
    if (!current || current.deliveryClaimId !== input.claimId) {
      return {
        state,
        result: null,
      };
    }

    const finalized: SavedNotification = {
      ...input.notification,
      deliveryClaimId: null,
      deliveryClaimPid: null,
    };

    return {
      state: {
        ...state,
        notifications: upsertNotification(state.notifications, finalized),
      },
      result: finalized,
    };
  });
}

export async function deliverPendingNotifications(
  options: {
    env?: string;
    clientFactory?: WatchClientFactory;
    now?: () => string;
    claimTimeoutMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<SavedNotification[]> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const now = options.now ?? nowIso;
  const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const claimed = await claimPendingNotifications(options);
  const delivered: SavedNotification[] = [];

  for (const notification of claimed) {
    const attemptedAt = now();
    const attemptedAtMs = Date.parse(attemptedAt);
    let result: SavedNotification;

    /** A route that can never succeed again. Stops retrying and releases the watcher. */
    const terminal = (reason: string): SavedNotification => ({
      ...notification,
      status: "undeliverable",
      updatedAt: attemptedAt,
      lastAttemptedAt: attemptedAt,
      lastError: reason,
      nextAttemptAt: null,
    });

    try {
      const state = await loadState();
      const subscriptionStillExists = state.subscriptions.some((subscription) => {
        return (
          subscription.subscriberThreadId === notification.subscriberThreadId &&
          subscription.sourceThreadId === notification.sourceThreadId
        );
      });

      const subscriberEnvironment = subscriptionStillExists
        ? (state.environments.find(
            (environment) => environment.name === notification.subscriberEnvironment,
          ) ?? null)
        : null;

      if (!subscriptionStillExists) {
        result = terminal("Subscription no longer exists.");
      } else if (!subscriberEnvironment) {
        // The environment was forgotten; nothing can route this notification again.
        result = terminal(`Unknown environment '${notification.subscriberEnvironment}'.`);
      } else if (credentialExpiry(subscriberEnvironment, attemptedAtMs)) {
        // Nothing the watcher can retry into: the pairing has to be renewed by a
        // human. Park the notification instead of burning its attempt budget, and
        // say exactly what unblocks it. `t3-thread pair` releases these again.
        result = {
          ...notification,
          status: "blocked",
          updatedAt: attemptedAt,
          lastAttemptedAt: attemptedAt,
          nextAttemptAt: null,
          lastError: `Credentials for environment '${subscriberEnvironment.name}' expired at ${subscriberEnvironment.expiresAt}. Re-pair with \`t3-thread pair --name ${subscriberEnvironment.name} ...\` to resume delivery.`,
        };
      } else {
        const subscriberClient = clientFactory(subscriberEnvironment);
        const subscriberThread = await subscriberClient.findThread(notification.subscriberThreadId);
        const subscriberStatus = classifyThread(subscriberThread);

        if (subscriberThread.archivedAt || subscriberThread.deletedAt) {
          result = terminal(
            `Subscriber thread '${notification.subscriberThreadId}' is archived and can no longer be notified.`,
          );
        } else if (subscriberStatus.state === "running") {
          // Expected, not a failure: hold the event and re-offer it shortly.
          // The attempt budget is reserved for real delivery errors.
          result = {
            ...notification,
            status: "pending",
            updatedAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError: "Subscriber thread is still running.",
            nextAttemptAt: new Date(attemptedAtMs + BUSY_RECIPIENT_RETRY_MS).toISOString(),
          };
        } else {
          await subscriberClient.sendMessage({
            threadId: notification.subscriberThreadId,
            text: buildNotificationMessage(notification),
          });
          result = {
            ...notification,
            status: "delivered",
            updatedAt: attemptedAt,
            deliveredAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError: null,
            nextAttemptAt: null,
          };
        }
      }
    } catch (error) {
      const attempts = (notification.attempts ?? 0) + 1;
      const message = error instanceof Error ? error.message : String(error);
      result =
        attempts >= maxAttempts
          ? {
              ...terminal(`${message} (gave up after ${attempts} attempts)`),
              attempts,
            }
          : {
              ...notification,
              status: "delivery-failed",
              attempts,
              updatedAt: attemptedAt,
              lastAttemptedAt: attemptedAt,
              lastError: message,
              nextAttemptAt: nextAttemptAt(attemptedAt, attempts),
            };
    }

    const persisted = await finalizeNotificationAttempt({
      notification: result,
      claimId: notification.deliveryClaimId ?? null,
    });
    if (persisted) {
      delivered.push(persisted);
    }
  }

  return delivered;
}

/**
 * Return notifications parked on expired credentials to the retry queue.
 *
 * Called after a successful `pair`, which is the only thing that can unblock them.
 */
export async function unblockNotificationsForEnvironment(
  environmentName: string,
  options: { now?: () => string } = {},
): Promise<SavedNotification[]> {
  const now = (options.now ?? nowIso)();

  return updateState(async (state) => {
    const released: SavedNotification[] = [];
    let notifications = state.notifications;

    for (const notification of state.notifications) {
      if (notification.status !== "blocked") {
        continue;
      }
      if (notification.subscriberEnvironment !== environmentName) {
        continue;
      }
      const next: SavedNotification = {
        ...notification,
        status: "pending",
        updatedAt: now,
        lastError: null,
        nextAttemptAt: null,
      };
      notifications = upsertNotification(notifications, next);
      released.push(next);
    }

    return {
      state: {
        ...state,
        notifications,
      },
      result: released,
    };
  });
}

export type WatcherExitDecision =
  | { exit: false }
  | { exit: true; reason: "idle" | "max-lifetime"; handoff: boolean };

/**
 * Whether the watcher loop should stop, and whether a replacement must be spawned.
 *
 * The watcher never idle-exits with work outstanding. The max-lifetime backstop
 * still stops a long-lived process, but when work remains that stop hands off to
 * a fresh watcher instead of dropping undelivered notifications on the floor.
 */
export function decideWatcherExit(input: {
  elapsedMs: number;
  idleMs: number;
  idleExitMs: number;
  maxLifetimeMs: number;
  workRemaining: boolean;
}): WatcherExitDecision {
  if (input.maxLifetimeMs > 0 && input.elapsedMs >= input.maxLifetimeMs) {
    return { exit: true, reason: "max-lifetime", handoff: input.workRemaining };
  }
  if (!input.workRemaining && input.idleExitMs > 0 && input.idleMs >= input.idleExitMs) {
    return { exit: true, reason: "idle", handoff: false };
  }
  return { exit: false };
}
