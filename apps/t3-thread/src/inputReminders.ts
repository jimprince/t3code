import { findPendingRequests } from "./nesting.js";
import type {
  OrchestrationThread,
  OrchestrationThreadShell,
  SavedNotification,
  SavedSubscription,
} from "./types.js";

export const DEFAULT_INPUT_REMINDER_MINUTES = 20;

export function parseInputReminderMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || value.trim() === "")
    throw new Error("Input reminder minutes must be a non-negative number (0 disables reminders).");
  return minutes;
}

export function pendingInputKey(thread: OrchestrationThread): string | null {
  const ids = findPendingRequests(thread.activities)
    .map((request) => `${request.kind}:${request.requestId}`)
    .sort();
  return ids.length ? JSON.stringify(ids) : null;
}

/** One durable reminder per request, measured from the initial confirmed delivery. */
export function withInputReminder(
  detected: SavedNotification,
  history: ReadonlyArray<SavedNotification>,
  subscription: SavedSubscription | undefined,
): SavedNotification {
  const minutes = subscription?.inputReminderMinutes ?? DEFAULT_INPUT_REMINDER_MINUTES;
  if (!detected.isChildInput || minutes === 0) return detected;
  const reminder = history.find((candidate) => candidate.reminderOfEventKey === detected.eventKey);
  if (reminder)
    return { ...detected, eventKey: reminder.eventKey, reminderOfEventKey: detected.eventKey };
  const delivered = history.find(
    (candidate) =>
      candidate.eventKey === detected.eventKey &&
      candidate.status === "delivered" &&
      candidate.deliveredAt,
  );
  if (
    !delivered ||
    Date.parse(detected.updatedAt) - Date.parse(delivered.deliveredAt!) < minutes * 60_000
  )
    return detected;
  return {
    ...detected,
    eventKey: `${detected.eventKey}:reminder:${delivered.id}`,
    reminderOfEventKey: detected.eventKey,
  };
}

export function inputNotificationStillCurrent(
  notification: SavedNotification,
  thread: OrchestrationThread,
): boolean {
  return (
    !thread.archivedAt &&
    !thread.deletedAt &&
    thread.settledOverride !== "settled" &&
    (!notification.isChildInput || matchesCurrentParent(thread, notification)) &&
    notification.pendingInputRequestKey != null &&
    pendingKeysStillCurrent(notification.pendingInputRequestKey, thread)
  );
}

function pendingKeysStillCurrent(key: string, thread: OrchestrationThread): boolean {
  const pending = new Set(
    findPendingRequests(thread.activities).flatMap((request) => [
      request.requestId,
      `${request.kind}:${request.requestId}`,
    ]),
  );
  try {
    const keys: unknown = JSON.parse(key);
    return (
      Array.isArray(keys) &&
      keys.length > 0 &&
      keys.every((id) => typeof id === "string" && pending.has(id))
    );
  } catch {
    return false;
  }
}

/** Remote parent IDs are scoped to their stable descriptor, never a saved alias. */
export function matchesCurrentParent(
  thread: Pick<OrchestrationThreadShell, "parentThreadId" | "remoteParent">,
  route: { subscriberThreadId: string; subscriberEnvironmentId?: string },
): boolean {
  return thread.remoteParent
    ? thread.remoteParent.threadId === route.subscriberThreadId &&
        thread.remoteParent.environmentId === route.subscriberEnvironmentId
    : thread.parentThreadId === route.subscriberThreadId;
}
