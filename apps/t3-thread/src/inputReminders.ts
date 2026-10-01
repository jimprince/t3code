import { findPendingRequests } from "./nesting.js";
import type { OrchestrationThread, SavedNotification, SavedSubscription } from "./types.js";

export const DEFAULT_INPUT_REMINDER_MINUTES = 45;

export function parseInputReminderMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || value.trim() === "")
    throw new Error("Input reminder minutes must be a non-negative number (0 disables reminders).");
  return minutes;
}

export function pendingInputKey(thread: OrchestrationThread): string | null {
  const ids = findPendingRequests(thread.activities)
    .filter((request) => request.kind === "user-input")
    .map((request) => request.requestId)
    .sort();
  return ids.length ? JSON.stringify(ids) : null;
}

/** Schedule one reminder after the last confirmed delivery, never a backlog after sleep. */
export function withInputReminder(
  detected: SavedNotification,
  history: ReadonlyArray<SavedNotification>,
  subscription: SavedSubscription | undefined,
): SavedNotification {
  const minutes = subscription?.inputReminderMinutes ?? DEFAULT_INPUT_REMINDER_MINUTES;
  if (!detected.isChildInput || minutes === 0) return detected;
  const delivered = history
    .filter(
      (candidate) =>
        (candidate.eventKey === detected.eventKey ||
          candidate.reminderOfEventKey === detected.eventKey) &&
        candidate.status === "delivered" &&
        candidate.deliveredAt != null,
    )
    .sort((a, b) => b.deliveredAt!.localeCompare(a.deliveredAt!))[0];
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
    (!notification.reminderOfEventKey ||
      thread.parentThreadId === notification.subscriberThreadId) &&
    pendingInputKey(thread) === notification.pendingInputRequestKey
  );
}
