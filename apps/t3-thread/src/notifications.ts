import * as NodeCrypto from "node:crypto";

import { summarizeMessageText, type AgentOverview } from "./monitor.js";
import type {
  OrchestrationThread,
  SavedAgent,
  SavedNotification,
  SavedNotificationStatus,
  SavedSubscription,
} from "./types.js";

/** Failed delivery attempts before a notification is given up on. */
export const MAX_DELIVERY_ATTEMPTS = 6;

/** Statuses the watcher can no longer act on by itself. */
export const TERMINAL_NOTIFICATION_STATUSES = new Set<SavedNotificationStatus>([
  "delivered",
  "undeliverable",
  "blocked",
  "superseded",
]);

const RETRY_BASE_MS = 15_000;
const RETRY_CEILING_MS = 10 * 60_000;

/**
 * Exponential backoff for a failed delivery. Without it a permanently failing
 * route is retried on every 5s watcher scan, which both hammers the environment
 * and hides the failure in a wall of identical log lines.
 */
export function retryDelayMs(attempts: number): number {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(RETRY_CEILING_MS, RETRY_BASE_MS * 2 ** exponent);
}

/** Absolute time the next attempt becomes claimable. */
export function nextAttemptAt(now: string, attempts: number): string {
  return new Date(Date.parse(now) + retryDelayMs(attempts)).toISOString();
}

export function buildNotificationEventKey(input: {
  subscriberThreadId: string;
  sourceThreadId: string;
  latestAssistantMessageId: string | null;
  latestTurnId: string | null;
  sourceState: string;
}): string {
  const marker = input.latestAssistantMessageId
    ? `assistant:${input.latestAssistantMessageId}`
    : input.latestTurnId
      ? `turn:${input.latestTurnId}:${input.sourceState}`
      : `state:${input.sourceState}`;
  return `${input.subscriberThreadId}:${input.sourceThreadId}:${input.latestTurnId ?? "none"}:${input.sourceState}:${marker}`;
}

export function buildNotificationRecord(input: {
  sourceAgent: SavedAgent;
  subscription: SavedSubscription;
  overview: AgentOverview;
  thread: OrchestrationThread;
  now: string;
  existing?: SavedNotification | null;
}): SavedNotification {
  const eventKey =
    input.existing?.eventKey ??
    JSON.stringify([
      input.subscription.sourceEnvironment,
      input.subscription.subscriberEnvironment,
    ]) +
      ":" +
      buildNotificationEventKey({
        subscriberThreadId: input.subscription.subscriberThreadId,
        sourceThreadId: input.subscription.sourceThreadId,
        latestAssistantMessageId: input.overview.latestAssistantMessageId,
        latestTurnId: input.thread.latestTurn?.turnId ?? null,
        sourceState: input.overview.state,
      });

  return {
    id: input.existing?.id ?? NodeCrypto.randomUUID(),
    eventKey,
    subscriberThreadId: input.subscription.subscriberThreadId,
    subscriberAgentName: input.subscription.subscriberAgentName,
    subscriberEnvironment: input.subscription.subscriberEnvironment,
    sourceThreadId: input.subscription.sourceThreadId,
    sourceAgentName: input.subscription.sourceAgentName,
    sourceEnvironment: input.subscription.sourceEnvironment,
    sourceState: input.overview.state,
    reason: input.overview.reason,
    latestAssistantMessageId: input.overview.latestAssistantMessageId,
    latestTurnId: input.thread.latestTurn?.turnId ?? null,
    preview: input.overview.latestAssistantPreview,
    status: input.existing?.status ?? "pending",
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
    deliveredAt: input.existing?.deliveredAt ?? null,
    lastAttemptedAt: input.existing?.lastAttemptedAt ?? null,
    lastError: input.existing?.lastError ?? null,
    deliveryClaimId: input.existing?.deliveryClaimId ?? null,
    deliveryClaimPid: input.existing?.deliveryClaimPid ?? null,
    attempts: input.existing?.attempts ?? 0,
    nextAttemptAt: input.existing?.nextAttemptAt ?? null,
  };
}

export function mergeDetectedNotification(
  existing: SavedNotification | null,
  detected: SavedNotification,
): SavedNotification {
  if (!existing) {
    return detected;
  }

  // Re-detection refreshes the event's description, never its delivery progress:
  // a record that already reached a terminal status must not become pending again.
  return {
    ...detected,
    id: existing.id,
    status: existing.status,
    createdAt: existing.createdAt,
    deliveredAt: existing.deliveredAt ?? null,
    lastAttemptedAt: existing.lastAttemptedAt ?? null,
    lastError: existing.lastError ?? null,
    deliveryClaimId: existing.deliveryClaimId ?? null,
    deliveryClaimPid: existing.deliveryClaimPid ?? null,
    attempts: existing.attempts ?? 0,
    nextAttemptAt: existing.nextAttemptAt ?? null,
  };
}

/**
 * Text delivered to the subscriber. A completed source also asks the
 * supervisor to decide whether the worker is finished, because nothing else
 * settles a quiet worker before automatic settlement days later.
 */
export function buildNotificationMessage(notification: SavedNotification): string {
  const sourceLabel = notification.sourceAgentName ?? notification.sourceThreadId;
  const preview = notification.preview ? summarizeMessageText(notification.preview, 120) : null;
  return [
    `T3 orchestrator notification: ${sourceLabel} ${notification.sourceState === "completed" ? "completed a turn" : "needs attention"}.`,
    `State: ${notification.sourceState}.`,
    `Reason: ${notification.reason}.`,
    preview ? `Latest output: ${preview}.` : null,
    notification.sourceState === "completed"
      ? `Decide whether ${sourceLabel} is finished: if so, settle it with \`t3-thread settle ${sourceLabel}\`; if not, send it the follow-up.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}
