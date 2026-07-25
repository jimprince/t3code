import * as NodeCrypto from "node:crypto";

import { RemoteEnvironmentClient } from "./client.js";
import { buildAgentOverview, needsAttention } from "./monitor.js";
import {
  buildNotificationMessage,
  buildNotificationRecord,
  mergeDetectedNotification,
} from "./notifications.js";
import { loadState, requireEnvironment, updateState, upsertNotification } from "./state.js";
import { classifyThread } from "./status.js";
import type {
  OrchestrationThread,
  SavedEnvironment,
  SavedNotification,
  StateFile,
} from "./types.js";

const DELIVERY_CLAIM_TIMEOUT_MS = 60_000;

export interface WatchClient {
  findThread(threadId: string): Promise<OrchestrationThread>;
  sendMessage(input: { threadId: string; text: string }): Promise<void>;
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

function isClaimStale(notification: SavedNotification, nowMs: number, timeoutMs: number): boolean {
  if (notification.status !== "delivering") {
    return false;
  }

  const claimedAt = notification.lastAttemptedAt ?? notification.updatedAt;
  const claimedAtMs = Date.parse(claimedAt);
  if (Number.isNaN(claimedAtMs)) {
    return true;
  }
  return nowMs - claimedAtMs >= timeoutMs;
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
    const notifications = state.notifications.map((notification) => {
      if (!matchesEnvFilter(notification, options.env)) {
        return notification;
      }

      const retryable =
        notification.status === "pending" ||
        notification.status === "delivery-failed" ||
        isClaimStale(notification, claimedAtMs, claimTimeoutMs);
      if (!retryable) {
        return notification;
      }

      const next: SavedNotification = {
        ...notification,
        status: "delivering",
        updatedAt: claimedAt,
        lastAttemptedAt: claimedAt,
        lastError: null,
        deliveryClaimId: NodeCrypto.randomUUID(),
      };
      claimed.push(next);
      return next;
    });

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
  } = {},
): Promise<SavedNotification[]> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const now = options.now ?? nowIso;
  const claimed = await claimPendingNotifications(options);
  const delivered: SavedNotification[] = [];

  for (const notification of claimed) {
    const attemptedAt = now();
    let result: SavedNotification;

    try {
      const state = await loadState();
      const subscriptionStillExists = state.subscriptions.some((subscription) => {
        return (
          subscription.subscriberThreadId === notification.subscriberThreadId &&
          subscription.sourceThreadId === notification.sourceThreadId
        );
      });
      if (!subscriptionStillExists) {
        result = {
          ...notification,
          status: "delivery-failed",
          updatedAt: attemptedAt,
          lastAttemptedAt: attemptedAt,
          lastError: "Subscription no longer exists.",
        };
      } else {
        const subscriberEnvironment = requireEnvironment(state, notification.subscriberEnvironment);
        const subscriberClient = clientFactory(subscriberEnvironment);
        const subscriberThread = await subscriberClient.findThread(notification.subscriberThreadId);
        const subscriberStatus = classifyThread(subscriberThread);

        if (subscriberStatus.state === "running") {
          result = {
            ...notification,
            status: "pending",
            updatedAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError: "Subscriber thread is still running.",
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
          };
        }
      }
    } catch (error) {
      result = {
        ...notification,
        status: "delivery-failed",
        updatedAt: attemptedAt,
        lastAttemptedAt: attemptedAt,
        lastError: error instanceof Error ? error.message : String(error),
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

export async function hasWatcherWork(
  options: {
    env?: string;
    clientFactory?: WatchClientFactory;
  } = {},
): Promise<boolean> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const state = await loadState();

  if (
    state.notifications.some((notification) => {
      if (!matchesEnvFilter(notification, options.env)) {
        return false;
      }
      return notification.status !== "delivered";
    })
  ) {
    return true;
  }

  const subscriptions = state.subscriptions.filter((subscription) => {
    return !options.env || subscription.sourceEnvironment === options.env;
  });
  const seenSources = new Set<string>();

  for (const subscription of subscriptions) {
    if (seenSources.has(subscription.sourceThreadId)) {
      continue;
    }
    seenSources.add(subscription.sourceThreadId);

    const sourceEnvironment = requireEnvironment(state, subscription.sourceEnvironment);
    const sourceClient = clientFactory(sourceEnvironment);
    const sourceThread = await sourceClient.findThread(subscription.sourceThreadId);
    if (classifyThread(sourceThread).state === "running") {
      return true;
    }
  }

  return false;
}
