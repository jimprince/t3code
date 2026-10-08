import {
  groupedNotificationTitle,
  evaluateNotification,
  notificationEventKey,
  notificationMessage,
} from "@t3tools/client-runtime/notification-eligibility";
import type { ThreadNotificationEvent } from "@t3tools/contracts";
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";

export interface AgentActivityAlert {
  readonly title: string;
  readonly body: string;
}

type TransitionInput = {
  readonly nowMs?: number;
  readonly previousAggregate: RelayAgentActivityAggregateState | null;
  readonly nextAggregate: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
};

export function activityNotificationEvent(row: {
  notification?: ThreadNotificationEvent | null;
  phase: string;
  updatedAt: string;
}): ThreadNotificationEvent | null {
  if (row.notification !== undefined) return row.notification;
  const kind =
    row.phase === "waiting_for_approval"
      ? "approval"
      : row.phase === "waiting_for_input"
        ? "question"
        : row.phase === "failed"
          ? "error"
          : null;
  // Old persisted jobs remain readable; unknown successful replies stay quiet.
  return kind
    ? {
        kind,
        identity: `${row.phase}:${row.updatedAt}`,
        origin: "unknown",
        occurredAt: row.updatedAt,
      }
    : null;
}
function rowKey(row: RelayAgentActivityAggregateRow): string {
  const event = activityNotificationEvent(row);
  return event
    ? notificationEventKey(row.environmentId, row.threadId, event)
    : JSON.stringify([row.environmentId, row.threadId]);
}
function eligibleRow(row: RelayAgentActivityAggregateRow, nowMs: number) {
  return evaluateNotification({
    event: activityNotificationEvent(row),
    environmentId: row.environmentId,
    threadId: row.threadId,
    nowMs,
  }).eligible;
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

export function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

// A missing baseline is a replay, not a transition that should buzz the phone.
export function attentionTransitionRows(input: TransitionInput) {
  if (input.previousAggregate === null) return [];
  const previouslyAttention = new Set(
    input.previousAggregate.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  return input.nextAggregate.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase) &&
      eligibleRow(row, input.nowMs ?? 0),
  );
}

// Reconciliation uses only observed transitions. Event-driven delivery can
// include fresh completions whose running update never reached the device.
export function newlyTerminalRows(
  previousAggregate: RelayAgentActivityAggregateState | null,
  nextAggregate: RelayAgentActivityAggregateState,
  includeUnobserved = false,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previousAggregate === null) return [];
  const previous = new Map(
    previousAggregate.activities.map((row) => [
      JSON.stringify([row.environmentId, row.threadId]),
      row,
    ]),
  );
  return nextAggregate.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const prior = previous.get(JSON.stringify([row.environmentId, row.threadId]));
    return (
      (includeUnobserved || prior !== undefined) &&
      !(
        prior &&
        (prior.phase === "completed" || prior.phase === "failed") &&
        rowKey(prior) === rowKey(row)
      )
    );
  });
}

export function terminalTransitionRows(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
) {
  return newlyTerminalRows(
    input.previousAggregate,
    input.nextAggregate,
    input.includeUnobserved,
  ).filter((row) => {
    return alertAllowedForPhase(input.preferences, row.phase) && eligibleRow(row, input.nowMs);
  });
}

export function alertForActivityRows(
  rows: ReadonlyArray<RelayAgentActivityAggregateRow>,
): AgentActivityAlert | null {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return {
      title: first.threadTitle,
      body: notificationMessage(activityNotificationEvent(first)!),
    };
  }
  return {
    title: groupedNotificationTitle(
      rows.map((row) => activityNotificationEvent(row)!).filter(Boolean),
    ),
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

export function alertForAttentionTransition(input: TransitionInput): AgentActivityAlert | null {
  return alertForActivityRows(attentionTransitionRows(input));
}

export function alertForNewlyTerminal(
  input: TransitionInput & { readonly nowMs: number; readonly includeUnobserved?: boolean },
): AgentActivityAlert | null {
  return alertForActivityRows(terminalTransitionRows(input));
}

export function alertForTerminalAggregate(input: {
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs?: number;
}): AgentActivityAlert | null {
  const row = input.aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(input.preferences, row.phase) && eligibleRow(row, input.nowMs ?? 0)
    ? alertForActivityRows([row])
    : null;
}

export function shouldAlertForActivity(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly notification?: ThreadNotificationEvent | null;
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase) &&
    evaluateNotification({
      event: activityNotificationEvent(input),
      environmentId: input.environmentId ?? "",
      threadId: input.threadId ?? "",
      nowMs: input.nowMs,
    }).eligible
  );
}
