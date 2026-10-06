import { matchesCurrentParent } from "./parentRouting.js";
import { pendingRequests as findPendingRequests } from "./v2/requests.js";
import type {
  OrchestrationThread,
  SavedNotification,
  SavedSubscription,
  StateFile,
} from "./types.js";

export const DEFAULT_INPUT_REMINDER_MINUTES = 20;

export function parseInputReminderMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || value.trim() === "")
    throw new Error("Input reminder minutes must be a non-negative number (0 disables reminders).");
  return minutes;
}

export function pendingInputKey(thread: OrchestrationThread): string | null {
  const ids = findPendingRequests(thread)
    .map((request) => `${request.kind}:${request.id}`)
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
  state?: Pick<StateFile, "environments">,
): boolean {
  return (
    !thread.archivedAt &&
    !thread.deletedAt &&
    thread.settledOverride !== "settled" &&
    (!notification.isChildInput || matchesCurrentParent(thread, notification, state)) &&
    notification.pendingInputRequestKey != null &&
    pendingKeysStillCurrent(notification.pendingInputRequestKey, thread)
  );
}

function pendingKeysStillCurrent(key: string, thread: OrchestrationThread): boolean {
  const pending = new Set(
    findPendingRequests(thread).flatMap((request) => [request.id, `${request.kind}:${request.id}`]),
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
