import * as NodeCrypto from "node:crypto";

import { summarizeMessageText, type AgentOverview } from "./monitor.js";
import type {
  OrchestrationThread,
  SavedAgent,
  SavedNotification,
  SavedSubscription,
} from "./types.js";

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
  return `${input.subscriberThreadId}:${input.sourceThreadId}:${marker}`;
}

export function buildNotificationRecord(input: {
  sourceAgent: SavedAgent;
  subscription: SavedSubscription;
  overview: AgentOverview;
  thread: OrchestrationThread;
  now: string;
  existing?: SavedNotification | null;
}): SavedNotification {
  const eventKey = buildNotificationEventKey({
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
  };
}

export function mergeDetectedNotification(
  existing: SavedNotification | null,
  detected: SavedNotification,
): SavedNotification {
  if (!existing) {
    return detected;
  }

  return {
    ...detected,
    id: existing.id,
    status: existing.status,
    createdAt: existing.createdAt,
    deliveredAt: existing.deliveredAt ?? null,
    lastAttemptedAt: existing.lastAttemptedAt ?? null,
    lastError: existing.lastError ?? null,
    deliveryClaimId: existing.deliveryClaimId ?? null,
  };
}

export function buildNotificationMessage(notification: SavedNotification): string {
  const sourceLabel = notification.sourceAgentName ?? notification.sourceThreadId;
  const preview = notification.preview ? summarizeMessageText(notification.preview, 120) : null;
  return [
    `HomeNetwork orchestrator notification: ${sourceLabel} needs attention.`,
    `State: ${notification.sourceState}.`,
    `Reason: ${notification.reason}.`,
    preview ? `Latest output: ${preview}.` : null,
  ]
    .filter(Boolean)
    .join(" ");
}
