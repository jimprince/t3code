import {
  recipientKey,
  sameNotificationRoute,
  matchesCurrentParent,
  mapRouteEnvironment,
  parentInputRoute,
} from "./parentRouting.js";
import { observeInactivity, inactivityStillCurrent } from "./inactivity.js";
import { withInputReminder, inputNotificationStillCurrent } from "./inputReminders.js";
import { notificationOrigin } from "./focusNotifications.js";
import * as NodeCrypto from "node:crypto";
import {
  sendOutcomeFailure,
  sendOutcomeHeld,
  sendTransportCause,
  sendWasNeverSubmitted,
} from "./sendIntents.js";
import type { HandoffLookupInput, HandoffLookupResult } from "@t3tools/contracts";

import { RemoteEnvironmentClient } from "./client.js";
import { buildAgentOverview, needsAttention } from "./monitor.js";
import {
  buildNotificationMessage,
  buildNotificationRecord,
  MAX_DELIVERY_ATTEMPTS,
  mergeDetectedNotification,
  shouldNotify,
  shouldDeliverNotification,
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
  SavedSubscription,
  StateFile,
} from "./types.js";

const DELIVERY_CLAIM_TIMEOUT_MS = 60_000;

/** How long to wait before re-offering a notification to a recipient that is mid-turn. */
const BUSY_RECIPIENT_RETRY_MS = 30_000;

/** How often a running watcher rechecks settlement and quota holds. */
const SETTLED_RECIPIENT_RECHECK_MS = 60_000;
/**
 * A worker that settles itself at close-out is settled seconds after its final
 * turn, often before any poll saw that turn complete. A settled source still
 * reports a turn that finished this recently; older settled threads stay skipped.
 */
const SETTLED_COMPLETION_WINDOW_MS = 60 * 60_000;
/** Keeps the watcher awake just long enough to record a completion that settled before the next pass. */
const SETTLED_COMPLETION_GRACE_MS = 2 * 60_000;

function finishedWithin(
  thread: Pick<OrchestrationThread, "latestTurn" | "settledAt">,
  nowMs: number,
  windowMs: number,
): boolean {
  const finishedAt = Date.parse(thread.latestTurn?.completedAt ?? thread.settledAt ?? "");
  return Number.isFinite(finishedAt) && nowMs - finishedAt <= windowMs;
}

/**
 * A settled source whose shell shows no live work and no completion inside `windowMs`. Reading
 * its full thread could only conclude the same, so watch passes skip that read: each one opened
 * a connection and a thread snapshot per settled source, every tick.
 */
function quietSettledSource(
  shell: OrchestrationThreadShell | undefined,
  nowMs: number,
  windowMs: number,
): boolean {
  return (
    shell !== undefined &&
    shell.settledOverride === "settled" &&
    !shell.activeRunId &&
    !shell.hasPendingApprovals &&
    !shell.hasPendingUserInput &&
    !finishedWithin(shell, nowMs, windowMs)
  );
}

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
  findThread(threadId: string, options?: { nesting?: boolean }): Promise<OrchestrationThread>;
  supportsReliableHandoffs?(): Promise<boolean>;
  lookupSendReceipt?(input: HandoffLookupInput): Promise<HandoffLookupResult>;
  sendMessage(input: {
    commandId?: string;
    threadId: string;
    text: string;
    queueWhileRunning?: boolean;
    origin?: import("@t3tools/shared/messageOrigin").MessageOrigin | null;
  }): Promise<unknown>;
}

export type WatchClientFactory = (environment: SavedEnvironment) => WatchClient;

function createWatchClient(environment: SavedEnvironment): WatchClient {
  return new RemoteEnvironmentClient(environment);
}

/**
 * What a full read of a quiet thread could add beyond its shell. Undefined while a run is
 * live: inactivity and progress come from the full thread, so those are always read.
 */
function quietShellSignature(shell: OrchestrationThreadShell): string | undefined {
  if (shell.activeRunId || ["running", "queued", "starting"].includes(shell.status ?? "")) {
    return undefined;
  }
  return JSON.stringify([
    shell.updatedAt,
    shell.status ?? null,
    shell.lastError ?? null,
    shell.settledOverride ?? null,
    shell.settledAt ?? null,
    shell.unsettledAt ?? null,
    shell.archivedAt,
    shell.latestTurn?.turnId ?? null,
    shell.latestTurn?.state ?? null,
    shell.latestTurn?.completedAt ?? null,
    shell.latestUserMessageAt,
    shell.hasPendingApprovals,
    shell.hasPendingUserInput,
    shell.hasActionableProposedPlan,
    shell.parentThreadId ?? null,
    shell.remoteParent ?? null,
  ]);
}

/** A full read without metadata, given the nesting fields its listed shell carries. */
function withListedNesting(
  thread: OrchestrationThread,
  shell: OrchestrationThreadShell,
): OrchestrationThread {
  return {
    ...thread,
    ...("parentThreadId" in shell ? { parentThreadId: shell.parentThreadId } : {}),
    ...("remoteParent" in shell ? { remoteParent: shell.remoteParent } : {}),
    ...("scope" in shell ? { scope: shell.scope } : {}),
    ...("subproject" in shell ? { subproject: shell.subproject } : {}),
  };
}

/** What makes a live source worth reading again before LIVE_SOURCE_REREAD_MS passes. */
function liveShellSignature(shell: OrchestrationThreadShell): string {
  return JSON.stringify([
    shell.status ?? null,
    shell.activeRunId ?? null,
    shell.latestTurn?.turnId ?? null,
    shell.hasPendingApprovals,
    shell.hasPendingUserInput,
    shell.hasActionableProposedPlan,
  ]);
}
// Passes are seconds apart once settled and unchanged sources cost nothing. A live run's
// inactivity thresholds are minutes, and its requests and completion show in the shell, so
// its full read and the shell list itself are refreshed on these slower clocks.
const LIVE_SOURCE_REREAD_MS = 30_000;
const SHELL_LIST_TTL_MS = 15_000;

/** Per-watcher cache: share reads within a pass, park terminal mappings for its lifetime.
 * Settled sources re-check each minute so remote unsettle remains observable. A source
 * whose shell is unchanged since its last full read reuses that read (a live one for at most
 * LIVE_SOURCE_REREAD_MS): each full read is a connection and a thread snapshot.
 */
export function createWatchPoller(factory: WatchClientFactory = createWatchClient, now = Date.now) {
  const reads = new Map<string, Promise<OrchestrationThread>>();
  // One shell list per environment per pass: the attention scan and the liveness check both
  // discover routes from it.
  const lists = new Map<string, { at: number; list: Promise<OrchestrationThreadShell[]> }>();
  // This pass's quiet-shell signatures, and the full read each source last had under one.
  const signatures = new Map<string, { signature: string; live: boolean }>();
  // The current list's shells, which already carry nesting fields from one metadata read.
  const listedShells = new Map<string, OrchestrationThreadShell>();
  const signedReads = new Map<
    string,
    { signature: string; at: number; read: Promise<OrchestrationThread> }
  >();
  const parked = new Map<
    string,
    { until: number; read: Promise<OrchestrationThread>; reason: string }
  >();
  const clientFactory: WatchClientFactory = (environment) => ({
    listThreads() {
      const cached = lists.get(environment.name);
      if (cached && now() - cached.at < SHELL_LIST_TTL_MS) return cached.list;
      const forget = () => {
        for (const key of signatures.keys())
          if (key.startsWith(`${environment.name}:`)) signatures.delete(key);
        for (const key of listedShells.keys())
          if (key.startsWith(`${environment.name}:`)) listedShells.delete(key);
      };
      const list = (factory(environment).listThreads?.() ?? Promise.resolve([])).then((shells) => {
        forget();
        for (const shell of shells) {
          listedShells.set(`${environment.name}:${shell.id}`, shell);
          const quiet = quietShellSignature(shell);
          signatures.set(
            `${environment.name}:${shell.id}`,
            quiet === undefined
              ? { signature: liveShellSignature(shell), live: true }
              : { signature: quiet, live: false },
          );
        }
        return shells;
      });
      // A failed list is retried by the next caller rather than reused.
      list.catch(() => {
        lists.delete(environment.name);
        forget();
      });
      lists.set(environment.name, { at: now(), list });
      return list;
    },
    findThread(threadId) {
      const key = `${environment.name}:${threadId}`;
      const skipped = parked.get(key);
      if (skipped && now() < skipped.until) return skipped.read;
      const signed = signatures.get(key);
      const previous = signedReads.get(key);
      if (
        !reads.has(key) &&
        signed !== undefined &&
        previous?.signature === signed.signature &&
        (!signed.live || now() - previous.at < LIVE_SOURCE_REREAD_MS)
      ) {
        return previous.read;
      }
      if (!reads.has(key)) {
        const shell = listedShells.get(key);
        // Listed: take nesting from the shell instead of re-reading every thread's metadata.
        const read: Promise<OrchestrationThread> = (
          shell
            ? factory(environment)
                .findThread(threadId, { nesting: false })
                .then((thread) => withListedNesting(thread, shell))
            : factory(environment).findThread(threadId)
        )
          .then((thread) => {
            if (signed !== undefined)
              signedReads.set(key, {
                signature: signed.signature,
                at: now(),
                read: Promise.resolve(thread),
              });
            else signedReads.delete(key);
            const reason =
              thread.archivedAt || thread.deletedAt
                ? "archived"
                : thread.settledOverride === "settled"
                  ? "settled"
                  : null;
            if (reason)
              parked.set(key, {
                until: reason === "settled" ? now() + 60_000 : Infinity,
                read: Promise.resolve(thread),
                reason,
              });
            else parked.delete(key);
            return thread;
          })
          .catch((error: unknown) => {
            if (isMissingThread(error)) {
              // Keep the rejected read to flag the mapping without hitting RPC every pass.
              parked.set(key, { until: Infinity, read, reason: "missing" });
            }
            throw error;
          });
        reads.set(key, read);
      }
      return reads.get(key)!;
    },
    sendMessage(input) {
      return factory(environment).sendMessage(input);
    },
    supportsReliableHandoffs: () =>
      factory(environment).supportsReliableHandoffs?.() ?? Promise.resolve(false),
    lookupSendReceipt: (input) =>
      factory(environment).lookupSendReceipt?.(input) ??
      Promise.resolve({ state: "unknown", receipts: [], retentionDays: 30 }),
  });
  return {
    clientFactory,
    beginPoll: () => reads.clear(),
    skippedMappings: () =>
      [...parked].map(([mapping, value]) => ({ mapping, reason: value.reason })),
  };
}

export function isMissingThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Thread .* was not found/i.test(message);
}

export function nextWatchInterval(intervalMs: number, workRemaining: boolean): number {
  return workRemaining ? intervalMs : Math.max(intervalMs, 60_000);
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
  const shellsBySource = new Map<string, OrchestrationThreadShell>();
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
      shellsBySource.set(key, shell);
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
  return { state: { ...state, agents, subscriptions }, observedSources, shellsBySource };
}

export async function scanAttentionNotifications(
  state: StateFile,
  options: AttentionScanOptions = {},
): Promise<SavedNotification[]> {
  const discovered = await discoverParentRoutes(state, options);
  return (await scanAttentionState(discovered.state, options, discovered.shellsBySource))
    .notifications;
}

async function scanAttentionState(
  state: StateFile,
  options: AttentionScanOptions,
  shellsBySource: ReadonlyMap<string, OrchestrationThreadShell> = new Map(),
): Promise<{ notifications: SavedNotification[]; observedSubscriptions: SavedSubscription[] }> {
  const clientFactory = options.clientFactory ?? createWatchClient;
  const now = options.now ?? nowIso;
  const scopedAgents = options.env
    ? state.agents.filter((savedAgent) => savedAgent.environment === options.env)
    : state.agents;
  const scanned: SavedNotification[] = [];
  const observedSubscriptions: SavedSubscription[] = [];

  for (const sourceAgent of scopedAgents) {
    if (
      !state.subscriptions.some(
        (subscription) =>
          subscription.sourceThreadId === sourceAgent.threadId &&
          subscription.sourceEnvironment === sourceAgent.environment,
      )
    )
      continue;
    if (
      quietSettledSource(
        shellsBySource.get(JSON.stringify([sourceAgent.environment, sourceAgent.threadId])),
        Date.parse(now()),
        SETTLED_COMPLETION_WINDOW_MS,
      )
    )
      continue;
    const sourceEnvironment = requireEnvironment(state, sourceAgent.environment);
    const sourceClient = clientFactory(sourceEnvironment);
    let sourceThread: OrchestrationThread;
    try {
      sourceThread = await sourceClient.findThread(sourceAgent.threadId);
    } catch {
      for (const subscription of state.subscriptions.filter(
        (route) => route.sourceThreadId === sourceAgent.threadId,
      )) {
        subscription.inactivityObservation = null;
        observedSubscriptions.push(subscription);
      }
      // Saved agents/subscriptions can outlive remote threads. A stale source
      // should not prevent detection for every other watched route.
      continue;
    }
    const overview = buildAgentOverview(sourceAgent, sourceThread);
    if (
      overview.state === "error" &&
      isNotificationReply(sourceThread) &&
      threadQuotaBlock(sourceThread)
    )
      continue;

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
      const inactive = observeInactivity(subscription, sourceThread, now());
      if (
        subscription.observedState !== overview.state ||
        subscription.observedReason !== overview.reason
      )
        subscription.errorEventKey = null;
      subscription.observedState = overview.state;
      subscription.observedReason = overview.reason;
      observedSubscriptions.push(subscription);
      if (inactive) {
        const detected = buildNotificationRecord({
          sourceAgent,
          subscription,
          overview: {
            ...overview,
            state: "inactive",
            reason: `No observable provider, tool, or reasoning progress for ${subscription.inactivityMinutes} minutes during an active turn. A silent long-running tool or hidden reasoning may still be working; inspect before intervening.`,
          },
          thread: sourceThread,
          now: now(),
        });
        detected.inactivityActivityAt = subscription.inactivityObservation!.activityAt;
        detected.eventKey = `${subscription.subscriberThreadId}:${sourceAgent.threadId}:inactive:${sourceThread.latestTurn!.turnId}:${detected.inactivityActivityAt}`;
        scanned.push(detected);
      }
      if (
        sourceThread.archivedAt ||
        sourceThread.deletedAt ||
        (sourceThread.settledOverride === "settled" &&
          !finishedWithin(sourceThread, Date.parse(now()), SETTLED_COMPLETION_WINDOW_MS))
      )
        continue;
      if (
        (overview.state === "completed" || overview.state === "idle") &&
        isNotificationReply(sourceThread)
      )
        continue;
      if (!needsAttention(overview) || !shouldNotify(subscription, overview, sourceThread))
        continue;
      // Attention for the turn that was already current when the subscriber
      // signed up is old news to it; only a later turn is a new transition.
      if (
        subscription.baselineTurnId &&
        (sourceThread.latestTurn?.turnId ?? null) === subscription.baselineTurnId &&
        !["needs-approval", "needs-input", "needs-plan", "error"].includes(overview.state)
      ) {
        continue;
      }
      const detected = buildNotificationRecord({
        sourceAgent,
        subscription,
        overview,
        thread: sourceThread,
        now: now(),
      });
      if (overview.state === "error") {
        const episode = state.notifications.find(
          (notification) => notification.eventKey === subscription.errorEventKey,
        );
        const occurrenceKey = JSON.stringify([
          detected.latestTurnId,
          detected.latestAssistantMessageId,
        ]);
        detected.eventKey = episode?.eventKey ?? `${detected.eventKey}:error:${detected.id}`;
        detected.occurrences =
          (episode?.occurrences ?? 0) + (episode?.lastOccurrenceKey === occurrenceKey ? 0 : 1);
        detected.lastOccurrenceKey = occurrenceKey;
        subscription.errorEventKey = detected.eventKey;
      }
      detected.isChildInput = isChildInput;
      detected.subscriberEnvironmentId = mapRouteEnvironment(
        state,
        subscription,
      ).subscriberEnvironmentId;
      scanned.push(detected);
    }
  }

  return { notifications: scanned, observedSubscriptions };
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
 * Unreachable sources with enabled inactivity monitoring retain the watcher;
 * unknown liveness cannot establish that assigned work has finished.
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

  const discovered = await discoverParentRoutes(state, options);
  state = discovered.state;
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
    if (
      quietSettledSource(
        discovered.shellsBySource.get(JSON.stringify([agent.environment, agent.threadId])),
        Date.now(),
        SETTLED_COMPLETION_GRACE_MS,
      )
    )
      continue;
    try {
      const environment = requireEnvironment(state, agent.environment);
      const thread = await clientFactory(environment).findThread(agent.threadId);
      if (
        !thread.deletedAt &&
        (thread.settledOverride !== "settled"
          ? IN_FLIGHT_SOURCE_STATES.has(classifyThread(thread).state)
          : !thread.archivedAt && finishedWithin(thread, Date.now(), SETTLED_COMPLETION_GRACE_MS))
      ) {
        return true;
      }
    } catch (error) {
      // Unknown liveness must not idle-exit an opted-in monitor during a transient outage.
      if (
        !isMissingThread(error) &&
        state.subscriptions.some(
          (route) =>
            route.sourceThreadId === agent.threadId &&
            route.level !== "none" &&
            (route.inactivityMinutes ?? 0) > 0,
        )
      )
        return true;
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
  const { notifications: scanned, observedSubscriptions } = await scanAttentionState(
    discovered.state,
    options,
    discovered.shellsBySource,
  );

  return updateState(async (currentState) => {
    const persisted: SavedNotification[] = [];
    let notifications = currentState.notifications;

    for (let notification of scanned) {
      // Another detector may have established this episode while our source
      // snapshot was in flight. Select its key and count under the state lock.
      if (notification.sourceState === "error") {
        const route = currentState.subscriptions.find((subscription) =>
          sameNotificationRoute(subscription, notification, currentState),
        );
        if (
          route?.observedState === "error" &&
          route.observedReason === notification.reason &&
          route.errorEventKey
        ) {
          notification = { ...notification, eventKey: route.errorEventKey };
          const observed = observedSubscriptions.find((subscription) =>
            sameNotificationRoute(subscription, notification, currentState),
          );
          if (observed) observed.errorEventKey = route.errorEventKey;
        }
      }
      notification = withInputReminder(
        notification,
        notifications,
        currentState.subscriptions.find((route) =>
          sameNotificationRoute(route, notification, currentState),
        ),
      );
      const existing =
        notifications.find((candidate) => candidate.eventKey === notification.eventKey) ??
        notifications.find(
          (candidate) =>
            notification.sourceState === "completed" &&
            candidate.sourceState === notification.sourceState &&
            sameNotificationRoute(candidate, notification, currentState) &&
            candidate.latestTurnId === notification.latestTurnId &&
            candidate.latestAssistantMessageId === notification.latestAssistantMessageId,
        ) ??
        null;
      if (notification.sourceState === "error") {
        notification = {
          ...notification,
          occurrences:
            (existing?.occurrences ?? 0) +
            (existing?.lastOccurrenceKey === notification.lastOccurrenceKey ? 0 : 1),
        };
      }
      const merged = mergeDetectedNotification(
        existing,
        existing ? { ...notification, eventKey: existing.eventKey } : notification,
      );
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
        ].map((route) => {
          const observed = observedSubscriptions.find((candidate) =>
            sameNotificationRoute(candidate, route, currentState),
          );
          return mapRouteEnvironment(
            currentState,
            observed
              ? {
                  ...route,
                  inactivityObservation:
                    observed.updatedAt === route.updatedAt &&
                    observed.inactivityMinutes === route.inactivityMinutes &&
                    (!route.inactivityObservation ||
                      !observed.inactivityObservation ||
                      Date.parse(observed.inactivityObservation.observedAt) >=
                        Date.parse(route.inactivityObservation.observedAt))
                      ? observed.inactivityObservation
                      : route.inactivityObservation,
                  observedState: observed.observedState,
                  observedReason: observed.observedReason,
                  errorEventKey: observed.errorEventKey,
                }
              : route,
          );
        }),
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
): Promise<Array<SavedNotification & { receiptRecovery?: boolean }>> {
  const now = options.now ?? nowIso;
  const claimTimeoutMs = options.claimTimeoutMs ?? DELIVERY_CLAIM_TIMEOUT_MS;
  const claimedAt = now();
  const claimedAtMs = Date.parse(claimedAt);

  return updateState(async (state) => {
    const claimed: Array<SavedNotification & { receiptRecovery?: boolean }> = [];
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

    // A different watcher may already be delivering another event to this
    // recipient. Serialize those too, including the first onboarding delivery.
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
        ...(notification.status === "delivering" ? { receiptRecovery: true } : {}),
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
      occurrences: current.occurrences,
      lastOccurrenceKey: current.lastOccurrenceKey,
      latestTurnId: current.latestTurnId,
      latestAssistantMessageId: current.latestAssistantMessageId,
      preview: current.preview,
      completionDisposition: current.completionDisposition,
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
    let transportAttempted = false;

    /** A route that can never succeed again. Stops retrying and releases the watcher. */
    const terminal = (reason: string): SavedNotification => ({
      ...notification,
      status: "undeliverable",
      updatedAt: attemptedAt,
      lastAttemptedAt: attemptedAt,
      lastError: reason,
      nextAttemptAt: null,
    });

    const retryFailure = (reason: string): SavedNotification => {
      const attempts = (notification.attempts ?? 0) + 1;
      return attempts >= maxAttempts
        ? { ...terminal(`${reason} (gave up after ${attempts} attempts)`), attempts }
        : {
            ...notification,
            ...(transportAttempted
              ? { sendId: notification.sendId ?? `notification:${notification.id}` }
              : {}),
            status: "delivery-failed",
            attempts,
            updatedAt: attemptedAt,
            lastAttemptedAt: attemptedAt,
            lastError: reason,
            nextAttemptAt: nextAttemptAt(attemptedAt, attempts),
          };
    };

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

      // A process crash does not authorize another delivery. Resolve its exact
      // identity first; an absent/expired receipt is honestly uncertain.
      if (notification.receiptRecovery) {
        let receipt: HandoffLookupResult | null = null;
        try {
          if (subscriberEnvironment && notification.sendId)
            receipt =
              (await clientFactory(subscriberEnvironment).lookupSendReceipt?.({
                type: "exact",
                sendId: notification.sendId,
              })) ?? null;
        } catch {
          /* No automatic resend after an uncertain lookup. */
        }
        const known = receipt?.state === "found" ? receipt.receipts[0] : null;
        const status =
          known && ["started", "steered", "queued"].includes(known.status)
            ? "delivered"
            : known && ["refused", "superseded", "cancelled"].includes(known.status)
              ? "undeliverable"
              : "uncertain";
        const persisted = await finalizeNotificationAttempt({
          notification: {
            ...notification,
            status,
            updatedAt: attemptedAt,
            nextAttemptAt: null,
            lastError: known?.cause ?? (status === "uncertain" ? "TRANSPORT_ERROR" : null),
          },
          claimId: notification.deliveryClaimId ?? null,
        });
        if (persisted) delivered.push(persisted);
        continue;
      }
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
        if (!shouldDeliverNotification(subscription, notification)) {
          result = {
            ...notification,
            status: "superseded",
            updatedAt: attemptedAt,
            lastError: "Completion suppressed by notification preference or direct result.",
            nextAttemptAt: null,
          };
          const persisted = await finalizeNotificationAttempt({
            notification: result,
            claimId: notification.deliveryClaimId ?? null,
          });
          if (persisted) delivered.push(persisted);
          continue;
        }
        if (notification.sourceState === "inactive") {
          const source = await clientFactory(
            requireEnvironment(state, notification.sourceEnvironment),
          ).findThread(notification.sourceThreadId);
          if (!inactivityStillCurrent(notification, subscription, source, now())) {
            result = {
              ...notification,
              status: "superseded",
              updatedAt: now(),
              lastError:
                "Worker resumed activity, is no longer active, or monitoring was disabled.",
            };
            const persisted = await finalizeNotificationAttempt({
              notification: result,
              claimId: notification.deliveryClaimId ?? null,
            });
            if (persisted) delivered.push(persisted);
            continue;
          }
        }
        if (notification.pendingInputRequestKey) {
          const source = await clientFactory(
            requireEnvironment(state, notification.sourceEnvironment),
          ).findThread(notification.sourceThreadId);
          if (
            (notification.isChildInput && !matchesCurrentParent(source, notification, state)) ||
            !inputNotificationStillCurrent(notification, source, state) ||
            (notification.reminderOfEventKey && subscription?.inputReminderMinutes === 0)
          ) {
            result = {
              ...notification,
              status: "superseded",
              updatedAt: attemptedAt,
              lastError: "Child input request is no longer actionable or reminders are disabled.",
              nextAttemptAt: null,
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
        const reliable =
          (await subscriberClient.supportsReliableHandoffs?.().catch(() => false)) ?? false;
        const subscriberStatus = classifyThread(subscriberThread);
        const quota = threadQuotaBlock(subscriberThread);

        if (subscriberThread.archivedAt || subscriberThread.deletedAt) {
          result = terminal(
            `Subscriber thread '${notification.subscriberThreadId}' is archived and can no longer be notified.`,
          );
        } else if (subscriberThread.settledOverride === "settled") {
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
        } else if (!reliable && ["running", "starting"].includes(subscriberStatus.state)) {
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
          )
            continue;
          const includeOnboarding = !state.notifications.some(
            (candidate) =>
              candidate.subscriberThreadId === notification.subscriberThreadId &&
              candidate.onboardingDelivered === true,
          );
          const sendId = notification.sendId ?? `notification:${notification.id}`;
          // Persist the identity in the claimed record before entering transport.
          await updateState(async (state) => ({
            state: {
              ...state,
              notifications: state.notifications.map((event) =>
                event.id === notification.id &&
                event.deliveryClaimId === notification.deliveryClaimId
                  ? { ...event, sendId }
                  : event,
              ),
            },
            result: undefined,
          }));
          transportAttempted = true;
          const outcome = await subscriberClient.sendMessage({
            commandId: sendId,
            threadId: notification.subscriberThreadId,
            text: buildNotificationMessage(notification, includeOnboarding),
            origin: notificationOrigin(notification),
            queueWhileRunning: true,
          });
          const failure = sendOutcomeFailure(outcome);
          const held = sendOutcomeHeld(outcome);
          result =
            failure?.retryable === true
              ? retryFailure(failure.causeCode)
              : {
                  ...notification,
                  sendId,
                  status: failure ? failure.status : held ? "uncertain" : "delivered",
                  onboardingDelivered: !failure && !held && includeOnboarding,
                  updatedAt: attemptedAt,
                  deliveredAt: failure || held ? null : attemptedAt,
                  lastAttemptedAt: attemptedAt,
                  lastError: failure?.causeCode ?? (held ? "SETTLED" : null),
                  nextAttemptAt: null,
                };
        }
      }
    } catch (error) {
      result =
        transportAttempted && !sendWasNeverSubmitted(error)
          ? {
              ...notification,
              sendId: notification.sendId ?? `notification:${notification.id}`,
              status: "uncertain",
              updatedAt: attemptedAt,
              lastError: sendTransportCause(error),
              nextAttemptAt: null,
            }
          : retryFailure(sendTransportCause(error));
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
