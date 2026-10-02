import { senderHeader } from "./thread-identity.js";
import { pendingInputKey, matchesCurrentParent } from "./inputReminders.js";
import * as NodeCrypto from "node:crypto";
import { findPendingRequests } from "./nesting.js";

import {
  getLatestTurnAssistantMessage,
  summarizeMessageText,
  type AgentOverview,
} from "./monitor.js";
import type {
  NotificationLevel,
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
  const baseKey = buildNotificationEventKey({
    subscriberThreadId: input.subscription.subscriberThreadId,
    sourceThreadId: input.subscription.sourceThreadId,
    latestAssistantMessageId: input.overview.latestAssistantMessageId,
    latestTurnId: input.thread.latestTurn?.turnId ?? null,
    sourceState: input.overview.state,
  });
  const requiresRequestKey = ["needs-approval", "needs-input", "needs-plan"].includes(
    input.overview.state,
  );
  const pendingIds = requiresRequestKey
    ? findPendingRequests(input.thread.activities)
        .map((request) => `${request.kind}:${request.requestId}`)
        .sort()
    : [];
  const isChildInput =
    ["needs-input", "needs-approval"].includes(input.overview.state) &&
    matchesCurrentParent(input.thread, input.subscription);
  const eventKey = isChildInput
    ? `${input.subscription.subscriberEnvironmentId ?? input.subscription.subscriberEnvironment}:${input.subscription.subscriberThreadId}:${input.thread.id}:pending:${pendingInputKey(input.thread)}`
    : requiresRequestKey
      ? `${baseKey}:${input.overview.state}:${JSON.stringify(pendingIds)}:${JSON.stringify(
          input.thread.proposedPlans
            .filter((plan) => !plan.implementedAt)
            .map((plan) => plan.id)
            .sort(),
        )}`
      : baseKey;

  return {
    pendingInputRequestKey: ["needs-input", "needs-approval"].includes(input.overview.state)
      ? pendingInputKey(input.thread)
      : null,
    isChildInput,
    pendingQuestion:
      input.overview.state === "needs-input"
        ? findPendingRequests(input.thread.activities)
            .flatMap((request) =>
              request.kind === "user-input"
                ? request.questions.map(
                    (question) =>
                      `${question.question}${question.options.length ? ` Choices: ${question.options.join(", ")}` : ""}`,
                  )
                : [],
            )
            .join("; ") || null
        : null,
    completionDisposition: turnResultDisposition(input.thread),
    id: input.existing?.id ?? NodeCrypto.randomUUID(),
    eventKey,
    subscriberThreadId: input.subscription.subscriberThreadId,
    subscriberAgentName: input.subscription.subscriberAgentName,
    subscriberEnvironment: input.subscription.subscriberEnvironment,
    subscriberEnvironmentId: input.subscription.subscriberEnvironmentId,
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
    onboardingDelivered: input.existing?.onboardingDelivered,
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
    onboardingDelivered: existing.onboardingDelivered,
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
export function buildNotificationMessage(
  notification: SavedNotification,
  includeOnboarding = false,
): string {
  const sourceLabel = notification.sourceAgentName ?? notification.sourceThreadId;
  const preview = notification.preview ? summarizeMessageText(notification.preview, 120) : null;
  const notice = [
    `T3 orchestrator notification: ${sourceLabel} ${notification.sourceState === "completed" ? "completed a turn" : "needs attention"}. ${senderHeader({ threadId: notification.sourceThreadId, name: notification.sourceAgentName, environment: notification.sourceEnvironment })}`,
    notification.reminderOfEventKey ? "Reminder: this sub-agent is still waiting for input." : null,
    `State: ${notification.sourceState}.`,
    `Reason: ${notification.reason}.`,
    (notification.occurrences ?? 1) > 1 ? `Occurrences: ${notification.occurrences}.` : null,
    preview ? `Latest output: ${preview}.` : null,
    notification.isChildInput
      ? "You are responsible for this child's pending request. Answer or approve it if you can, or route it to the chief of staff when one exists. Otherwise ask Brad with the structured question tool, or end your final response with T3_NOTIFY: attention so it appears in his Needs you."
      : null,
    notification.pendingQuestion ? `Pending question: ${notification.pendingQuestion}` : null,
    notification.sourceState === "completed"
      ? `Decide whether ${sourceLabel} is finished: if so, settle it with \`t3-thread settle ${sourceLabel}\`; if not, send it the follow-up.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
  const guide = includeOnboarding
    ? `Thread communication quick start: read output with \`t3-thread result ${sourceLabel}\`; inspect queued sends with \`t3-thread queue\`. Full guide: apps/t3-thread/docs/THREAD_COMMUNICATION.md.`
    : null;
  const controls = notification.isChildInput
    ? null
    : `Notifications: t3-thread agent subscribe --watch ${notification.sourceThreadId} --level attention|none · stop: t3-thread agent unsubscribe --watch ${notification.sourceThreadId}`;
  return [notice, guide, controls].filter(Boolean).join("\n");
}

/** Required escalation bypasses both subscription filtering and quiet completion. */
export function shouldNotify(
  subscription: SavedSubscription,
  overview: AgentOverview,
  thread: OrchestrationThread,
): boolean {
  return shouldDeliverNotification(subscription, {
    sourceState: overview.state,
    latestTurnId: thread.latestTurn?.turnId ?? null,
    completionDisposition: turnResultDisposition(thread),
  });
}

function turnResultDisposition(thread: OrchestrationThread): "quiet" | "attention" | null {
  const text = getLatestTurnAssistantMessage(thread)?.text.trim() ?? "";
  const disposition = text.match(/(?:^|\n)T3_NOTIFY: (quiet|attention)$/)?.[1];
  return disposition === "quiet" || disposition === "attention" ? disposition : null;
}

export function shouldDeliverNotification(
  subscription: SavedSubscription,
  notification: Pick<SavedNotification, "sourceState" | "latestTurnId" | "completionDisposition">,
): boolean {
  if (["needs-input", "needs-approval", "needs-plan", "error"].includes(notification.sourceState))
    return true;
  const level = subscription.level ?? "all";
  if (notification.sourceState === "inactive")
    return level !== "none" && (subscription.inactivityMinutes ?? 0) > 0;
  if (level === "none") return false;
  if (notification.sourceState === "completed") {
    const disposition = notification.completionDisposition;
    if (disposition === "quiet") return false;
    if (level === "all") return true;
    if (
      notification.latestTurnId != null &&
      subscription.lastDirectMessageTurnId === notification.latestTurnId
    )
      return false;
    return disposition === "attention";
  }
  return level === "all" || notification.sourceState === "interrupted";
}

export function parseNotificationLevel(value: string): NotificationLevel {
  if (value === "all" || value === "attention" || value === "none") return value;
  throw new Error("Notification level must be all, attention, or none.");
}
