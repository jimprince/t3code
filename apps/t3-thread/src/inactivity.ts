import { classifyThread } from "./status.js";
import { threadQuotaBlock } from "./quota.js";
import type { OrchestrationThread, SavedNotification, SavedSubscription } from "./types.js";

export function parseInactivityMinutes(value: string): number {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0 || value.trim() === "")
    throw new Error("Inactivity minutes must be a non-negative number (0 disables monitoring).");
  return minutes;
}

// Poll/session timestamps are not provider progress. These activities originate
// in provider ingestion; current-turn message updates include thinking traces.
const PROGRESS_KINDS = new Set([
  "tool.started",
  "tool.updated",
  "tool.progress",
  "tool.completed",
  "tool.denied",
  "task.started",
  "task.progress",
  "task.updated",
  "task.completed",
  "turn.plan.updated",
  "context-compaction",
]);

function activityAt(thread: OrchestrationThread): string | null {
  const turn = thread.latestTurn;
  if (
    !turn ||
    turn.state !== "running" ||
    thread.archivedAt ||
    thread.deletedAt ||
    thread.settledOverride === "settled" ||
    classifyThread(thread).state !== "running" ||
    threadQuotaBlock(thread) ||
    (thread.session && !["starting", "running"].includes(thread.session.status))
  )
    return null;
  const times = [turn.startedAt ?? turn.requestedAt];
  for (const message of thread.messages) {
    if (
      message.turnId === turn.turnId &&
      ["assistant", "reasoning"].includes(message.role) &&
      message.text
    )
      times.push(message.updatedAt);
  }
  for (const activity of thread.activities) {
    if (
      activity.turnId === turn.turnId &&
      PROGRESS_KINDS.has(String(activity.kind)) &&
      typeof activity.createdAt === "string"
    )
      times.push(activity.createdAt);
  }
  let latest: string | null = null;
  for (const time of times)
    if (
      Number.isFinite(Date.parse(time)) &&
      (latest === null || Date.parse(time) > Date.parse(latest))
    )
      latest = time;
  return latest;
}

/** Observe silence only across successful, recent reads, never through an outage or sleep. */
export function observeInactivity(
  subscription: SavedSubscription,
  thread: OrchestrationThread,
  now: string,
): boolean {
  const latest = activityAt(thread);
  const minutes = subscription.inactivityMinutes ?? 0;
  if (!latest || minutes === 0 || subscription.level === "none") {
    subscription.inactivityObservation = null;
    return false;
  }
  const previous = subscription.inactivityObservation;
  const nowMs = Date.parse(now);
  const continuous =
    previous?.turnId === thread.latestTurn!.turnId &&
    previous.activityAt === latest &&
    nowMs >= Date.parse(previous.observedAt) &&
    nowMs - Date.parse(previous.observedAt) <= 120_000;
  const quietSince = continuous ? previous.quietSince : now;
  subscription.inactivityObservation = {
    turnId: thread.latestTurn!.turnId,
    activityAt: latest,
    quietSince,
    observedAt: now,
  };
  return nowMs - Math.max(Date.parse(quietSince), Date.parse(latest)) >= minutes * 60_000;
}

export function inactivityStillCurrent(
  notification: SavedNotification,
  subscription: SavedSubscription,
  thread: OrchestrationThread,
  now: string,
): boolean {
  const observation = subscription.inactivityObservation;
  return (
    Boolean(
      observation &&
      Date.parse(now) -
        Math.max(Date.parse(observation.quietSince), Date.parse(observation.activityAt)) >=
        (subscription.inactivityMinutes ?? 0) * 60_000,
    ) &&
    (subscription.inactivityMinutes ?? 0) > 0 &&
    subscription.level !== "none" &&
    thread.latestTurn?.turnId === notification.latestTurnId &&
    activityAt(thread) === notification.inactivityActivityAt
  );
}
