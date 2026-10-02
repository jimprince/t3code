import {
  recipientKey,
  sameNotificationRoute,
  matchesCurrentParent,
  mapRouteEnvironment,
  parentInputRoute,
} from "./parentRouting.js";
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
import { threadQuotaBlock } from "./quota.js";
import { isProcessRunning } from "./watcher-process.js";
import type {
  OrchestrationThread,
  OrchestrationThreadShell,
  SavedEnvironment,
  SavedNotification,
  StateFile,
} from "./types.js";

const DELIVERY_CLAIM_TIMEOUT_MS = 60_000;

/** How long to wait before re-offering a notification to a recipient that is mid-turn. */
const BUSY_RECIPIENT_RETRY_MS = 30_000;

/** How often a running watcher rechecks settlement and quota holds. */
const SETTLED_RECIPIENT_RECHECK_MS = 60_000;

/**
 * When this process started. A claim stamped before that cannot be ours, even if
 * it records our pid, because the kernel recycles pids across watcher restarts.
 */
const PROCESS_STARTED_AT_MS = Date.now();

/** A normal reply to a routed notification must not wake another supervisor. */
function isNotificationReply(thread: OrchestrationThread): boolean {
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index]!;
    if (message.role === "user") {
      return /^(?:HomeNetwork|T3) orchestrator notification:/.test(message.text);
    }
  }
  return false;
}

export interface WatchClient {
  listThreads?(): Promise<OrchestrationThreadShell[]>;
  findThread(threadId: string): Promise<OrchestrationThread>;
  /** Result is unused here; `RemoteEnvironmentClient.sendMessage` reports dispatch vs queue. */
  sendMessage(input: {
    threadId: string;
    text: string;
    queueWhileRunning?: boolean;
  }): Promise<unknown>;
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

type AttentionScanOptions = {
  env?: string;
  clientFactory?: WatchClientFactory;
  now?: () => string;
};

/** Metadata reads discover UI-created children too; failures retain existing routes. */
async function discoverParentRoutes(state: StateFile, options: AttentionScanOptions) {
  const factory = options.clientFactory ?? createWatchClient;
  const agents = [...state.agents];
  const observedSources = new Set<string>();
  let subscriptions = [...state.subscriptions];
  for (const environment of state.environments) {
    if (options.env && environment.name !== options.env) continue;
    const client = factory(environment);
    let shells: OrchestrationThreadShell[];
    try {
      shells = (await client.listThreads?.()) ?? [];
    } catch {
      continue;
    }
    for (const shell of shells) {
      const key = JSON.stringify([environment.name, shell.id]);
      observedSources.add(key);
      let source = agents.find(
        (agent) => agent.environment === environment.name && agent.threadId === shell.id,
      );
      if (!source && (shell.parentThreadId || shell.remoteParent) && !shell.archivedAt) {
        source = {
          name: shell.id,
          threadId: shell.id,
          environment: environment.name,
          projectId: shell.projectId,
          title: shell.title,
          createdAt: shell.createdAt,
          lastSeenAssistantMessageId: null,
        };
        agents.push(source);
      }
      subscriptions = subscriptions.filter(
        (route) =>
          !route.nestingDerived ||
          route.sourceEnvironment !== environment.name ||
          route.sourceThreadId !== shell.id ||
          matchesCurrentParent(shell, route, state),
      );
      if (!source) continue;
      const parent = parentInputRoute(state, source, shell, (options.now ?? nowIso)());
      if (parent && !subscriptions.some((route) => sameNotificationRoute(route, parent, state)))
        subscriptions.push(parent);
    }
  }
  return { state: { ...state, agents, subscriptions }, observedSources };
}

export async function scanAttentionNotifications(
  state: StateFile,
  options: AttentionScanOptions = {},
): Promise<SavedNotification[]> {
  const discovered = await discoverParentRoutes(state, options);
  return scanKnownRoutes(discovered.state, options);
}

async function scanKnownRoutes(
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
    if (
      !state.subscriptions.some(
        (subscription) =>
          subscription.sourceThreadId === sourceAgent.threadId &&
          subscription.sourceEnvironment === sourceAgent.environment,
      )
    )
      continue;
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
    if (
      overview.state === "error" &&
      isNotificationReply(sourceThread) &&
      threadQuotaBlock(sourceThread)
    ) {
      continue;
    }

    const subscriptions = state.subscriptions.filter(
      (subscription) =>
        subscription.sourceThreadId === sourceAgent.threadId &&
        subscription.sourceEnvironment === sourceAgent.environment &&
        (!subscription.nestingDerived || matchesCurrentParent(sourceThread, subscription, state)),
    );
    if (subscriptions.length === 0) {
      continue;
    }

    for (const subscription of subscriptions) {
      const isChildInput =
        ["needs-input", "needs-approval"].includes(overview.state) &&
        matchesCurrentParent(sourceThread, subscription, state);
      if (subscription.nestingDerived && !isChildInput) continue;
      if (
        (overview.state === "completed" || overview.state === "idle") &&
        (subscription.events === "attention" || isNotificationReply(sourceThread))
      )
        continue;
      // Attention for the turn that was already current when the subscriber
      // signed up is old news to it; only a later turn is a new transition.
      if (
        subscription.baselineTurnId &&
        (sourceThread.latestTurn?.turnId ?? null) === subscription.baselineTurnId &&
        !isChildInput
      ) {
        continue;
      }
      const existing =
        state.notifications.find((notification) => {
          return (
            sameNotificationRoute(notification, subscription, state) &&
            notification.latestAssistantMessageId === overview.latestAssistantMessageId &&
            notification.latestTurnId === (sourceThread.latestTurn?.turnId ?? null) &&
            notification.sourceState === overview.state
          );
        }) ?? null;

      scanned.push({
        ...buildNotificationRecord({
          sourceAgent,
          subscription,
          overview,
          thread: sourceThread,
          now: now(),
          existing,
        }),
        isChildInput,
        subscriberEnvironmentId: mapRouteEnvironment(state, subscription).subscriberEnvironmentId,
      });
    }
  }

  return scanned;
}

/**
 * Statuses that always keep the watcher awake. Holds with a known quota reset
 * also keep it awake; indefinite holds wait for operator activity, since each
 * watcher pass snapshots every saved agent.
 */
const UNDELIVERED_STATUSES = new Set(["pending", "delivering", "delivery-failed"]);
const IN_FLIGHT_SOURCE_STATES = new Set([
  "running",
  "starting",
  "ready",
  "needs-approval",
  "needs-input",
  "needs-plan",
]);

/**
 * Undelivered statuses that a newer event on the same route may overtake.
 * Including `held` means a settled recipient keeps only the newest event from
 * each source, so unsettling it delivers current state rather than a backlog.
 */
const SUPERSEDABLE_STATUSES = new Set(["pending", "delivery-failed", "held"]);

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
  state: StateFile,
): SavedNotification[] {
  return notifications.map((candidate) => {
    if (
      candidate.eventKey === latest.eventKey ||
      !sameNotificationRoute(candidate, latest, state) ||
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
  let state = await loadState();

  const undelivered = state.notifications.some(
    (notification) =>
      (UNDELIVERED_STATUSES.has(notification.status) ||
        (notification.status === "held" && Boolean(notification.quotaResetAt))) &&
      matchesEnvFilter(notification, options.env),
  );
  if (undelivered) {
    return true;
  }

  state = (await discoverParentRoutes(state, options)).state;
  const subscribedSourceThreadIds = new Set(
    state.subscriptions.map((subscription) =>
      JSON.stringify([subscription.sourceEnvironment, subscription.sourceThreadId]),
    ),
  );
  if (subscribedSourceThreadIds.size === 0) {
    return false;
  }

  for (const agent of state.agents) {
    if (!subscribedSourceThreadIds.has(JSON.stringify([agent.environment, agent.threadId]))) {
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
  const discovered = await discoverParentRoutes(state, options);
  const scanned = await scanKnownRoutes(discovered.state, options);

  return updateState(async (currentState) => {
    const persisted: SavedNotification[] = [];
    let notifications = currentState.notifications;

    for (const notification of scanned) {
      const existing =
        notifications.find((candidate) => candidate.eventKey === notification.eventKey) ?? null;
      const merged = mergeDetectedNotification(existing, notification);
      notifications = upsertNotification(notifications, merged);
      notifications = supersedeOvertakenNotifications(
        notifications,
        merged,
        merged.updatedAt,
        currentState,
      );
      persisted.push(merged);
    }

    return {
      state: {
        ...currentState,
        notifications,
        subscriptions: [
          ...currentState.subscriptions.filter(
            (route) =>
              !route.nestingDerived ||
              !discovered.observedSources.has(
                JSON.stringify([route.sourceEnvironment, route.sourceThreadId]),
              ) ||
              discovered.state.subscriptions.some((observed) =>
                sameNotificationRoute(route, observed, currentState),
              ),
          ),
          ...discovered.state.subscriptions.filter(
            (route) =>
              route.nestingDerived &&
              !currentState.subscriptions.some((existing) =>
                sameNotificationRoute(route, existing, currentState),
              ),
          ),
        ].map((route) => mapRouteEnvironment(currentState, route)),
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

    const claimedSubscribers = new Set(
      state.notifications
        .filter(
          (notification) =>
            notification.status === "delivering" &&
            !isClaimStale(notification, claimedAtMs, claimTimeoutMs),
        )
        .map((notification) => recipientKey(notification, state)),
    );
    for (const notification of claimable) {
      if (claimedSubscribers.has(recipientKey(notification, state))) {
        continue;
      }
      claimedSubscribers.add(recipientKey(notification, state));
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
    if (!current || current.status !== "delivering" || current.deliveryClaimId !== input.claimId) {
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
      const subscription = state.subscriptions.find((route) =>
        sameNotificationRoute(route, notification, state),
      );
      const subscriptionStillExists = subscription != null;

      const subscriberEnvironment = subscriptionStillExists
        ? (state.environments.find((environment) =>
            notification.subscriberEnvironmentId
              ? environment.environmentId === notification.subscriberEnvironmentId
              : environment.name === notification.subscriberEnvironment,
          ) ?? null)
        : null;

      if (!subscriptionStillExists) {
        result = notification.isChildInput
          ? {
              ...notification,
              status: "superseded",
              updatedAt: attemptedAt,
              nextAttemptAt: null,
              lastError: "Organizational parent route no longer exists.",
            }
          : terminal("Subscription no longer exists.");
      } else if (!subscriberEnvironment) {
        // The environment was forgotten; nothing can route this notification again.
        result = notification.subscriberEnvironmentId
          ? {
              ...notification,
              status: "blocked",
              updatedAt: attemptedAt,
              nextAttemptAt: null,
              lastError: `Remote parent environment '${notification.subscriberEnvironmentId}' is not paired.`,
            }
          : terminal(`Unknown environment '${notification.subscriberEnvironment}'.`);
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
        if (subscription?.nestingDerived || notification.isChildInput) {
          const source = await clientFactory(
            requireEnvironment(state, notification.sourceEnvironment),
          ).findThread(notification.sourceThreadId);
          if (
            !matchesCurrentParent(source, notification, state) ||
            source.archivedAt ||
            source.deletedAt ||
            source.settledOverride === "settled" ||
            !["needs-input", "needs-approval"].includes(classifyThread(source).state)
          ) {
            result = {
              ...notification,
              status: "superseded",
              updatedAt: attemptedAt,
              nextAttemptAt: null,
              lastError: "Child no longer needs this parent to act.",
            };
            const persisted = await finalizeNotificationAttempt({
              notification: result,
              claimId: notification.deliveryClaimId ?? null,
            });
            if (persisted) delivered.push(persisted);
            continue;
          }
        }
        const subscriberClient = clientFactory(subscriberEnvironment);
        const subscriberThread = await subscriberClient.findThread(notification.subscriberThreadId);
        const subscriberStatus = classifyThread(subscriberThread);
        const quota = threadQuotaBlock(subscriberThread);

        if (subscriberThread.archivedAt || subscriberThread.deletedAt) {
          result = terminal(
            `Subscriber thread '${notification.subscriberThreadId}' is archived and can no longer be notified.`,
          );
        } else if (subscriberThread.settledOverride === "settled" && !notification.isChildInput) {
          // Delivery starts a turn, and the server unsettles a thread on any
          // turn. Hold the event until the user unsettles the recipient.
          result = {
            ...notification,
            status: "held",
            updatedAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError: "Subscriber thread is settled; held until it is unsettled.",
            quotaResetAt: null,
            nextAttemptAt: new Date(attemptedAtMs + SETTLED_RECIPIENT_RECHECK_MS).toISOString(),
          };
        } else if (quota && (quota.resetsAt === null || quota.resetsAt > attemptedAtMs)) {
          result = {
            ...notification,
            status: "held",
            updatedAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError:
              "Subscriber is quota-blocked; held until explicit retry or a reported reset.",
            quotaResetAt: quota.resetsAt === null ? null : new Date(quota.resetsAt).toISOString(),
            nextAttemptAt: new Date(attemptedAtMs + SETTLED_RECIPIENT_RECHECK_MS).toISOString(),
          };
        } else if (["running", "starting"].includes(subscriberStatus.state)) {
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
          // Snapshot reads can be slow; an unsubscribe during that read wins.
          const latest = await loadState();
          if (
            !latest.subscriptions.some((route) =>
              sameNotificationRoute(route, notification, latest),
            ) ||
            latest.notifications.find((event) => event.id === notification.id)?.status !==
              "delivering"
          ) {
            continue;
          }
          await subscriberClient.sendMessage({
            threadId: notification.subscriberThreadId,
            text: buildNotificationMessage(notification),
            queueWhileRunning: false,
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

/**
 * Make notifications held for `subscriberThreadId` due immediately.
 *
 * Called by `t3-thread unsettle`. A running watcher would find the thread
 * unsettled on its next re-check anyway; this skips the wait and lets the
 * caller start a watcher when none is running.
 */
export async function releaseHeldNotifications(
  subscriberThreadId: string,
  options: { now?: () => string } = {},
): Promise<SavedNotification[]> {
  const now = (options.now ?? nowIso)();

  return updateState(async (state) => {
    const released: SavedNotification[] = [];
    let notifications = state.notifications;

    for (const notification of state.notifications) {
      if (
        notification.status !== "held" ||
        notification.subscriberThreadId !== subscriberThreadId
      ) {
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
