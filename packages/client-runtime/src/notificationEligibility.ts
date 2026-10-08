import * as DateTime from "effect/DateTime";
import { readMessageOrigin } from "@t3tools/shared/messageOrigin";
import type { OrchestrationV2ThreadShell, ThreadNotificationEvent } from "@t3tools/contracts";

// Product policy: adapters supply state/identities/preferences, not audience rules.
const NOTIFICATION_CASES = {
  reply: { origins: ["human"], freshnessMs: 120_000, suppressOnlySameThreadWork: true },
  question: { origins: ["human", "worker", "routed", "automation", "unknown"], freshnessMs: null },
  approval: { origins: ["human", "worker", "routed", "automation", "unknown"], freshnessMs: null },
  decision: { origins: ["human", "worker", "routed", "automation", "unknown"], freshnessMs: null },
  error: { origins: ["human", "worker", "routed", "automation", "unknown"], freshnessMs: 120_000 },
  attention: { origins: ["human", "worker", "routed", "automation", "unknown"], freshnessMs: null },
} as const;
export function notificationEventKey(
  environmentId: string,
  threadId: string,
  event: ThreadNotificationEvent,
) {
  return JSON.stringify([environmentId, threadId, event.kind, event.identity]);
}
export function evaluateNotification(input: {
  readonly event: ThreadNotificationEvent | null | undefined;
  readonly environmentId: string;
  readonly threadId: string;
  readonly nowMs: number;
  readonly onScreen?: boolean;
  readonly archived?: boolean;
  readonly parentOwned?: boolean;
  readonly superseded?: boolean;
  readonly busy?: boolean;
  readonly quiet?: boolean;
  readonly seen?: ReadonlySet<string>;
  /**
   * The caller watched this event arrive (a live client comparing against its previous
   * snapshot), so it cannot be a replay. A failure then alerts however late the client
   * woke up; a replaying caller (relay push, reconciliation) leaves this off.
   */
  readonly observed?: boolean;
}) {
  const event = input.event;
  if (!event) return { eligible: false, key: null, reason: "no-event" };
  const key = notificationEventKey(input.environmentId, input.threadId, event);
  const rule = NOTIFICATION_CASES[event.kind];
  const timestamp = Date.parse(event.occurredAt);
  const reason = input.archived
    ? "archived"
    : input.parentOwned
      ? "parent-owned"
      : input.superseded
        ? "superseded"
        : input.onScreen
          ? "on-screen"
          : input.seen?.has(key)
            ? "duplicate"
            : ("suppressOnlySameThreadWork" in rule &&
                  rule.suppressOnlySameThreadWork &&
                  input.busy) ||
                (event.kind === "reply" && input.quiet)
              ? "unfinished-or-quiet"
              : !(rule.origins as readonly string[]).includes(event.origin)
                ? "automatic-or-unknown"
                : rule.freshnessMs !== null &&
                    !(input.observed && event.kind === "error") &&
                    (!Number.isFinite(timestamp) ||
                      input.nowMs - timestamp > rule.freshnessMs ||
                      timestamp > input.nowMs + 5_000)
                  ? "stale"
                  : null;
  return { eligible: reason === null, key, reason };
}
/** Alert copy approved in #190; the heading is always the source thread title. */
export function notificationMessage(
  event: ThreadNotificationEvent,
  errorReason?: string | null,
): string {
  switch (event.kind) {
    case "reply":
      return "Reply ready";
    case "question":
      return "Question for you";
    case "attention":
      return "Input needed";
    case "approval":
      return "Approval needed";
    case "decision":
      return "Decision needed";
    case "error":
      return `Error: ${(errorReason ?? event.errorReason)?.trim().split(/\r?\n/)[0]?.slice(0, 120) || "Agent failed"}`;
  }
}

/** The starting message is authoritative; unknown and automatic work fail closed. */
export function notificationOriginForMessage(
  message:
    | {
        readonly createdBy?: string | null;
        readonly creationSource?: string | null;
        readonly scheduledTaskId?: unknown;
        readonly senderThreadId?: unknown;
        readonly notification?: unknown;
        readonly text?: string | null;
        readonly context?: { readonly records: ReadonlyArray<unknown> } | undefined;
      }
    | null
    | undefined,
): ThreadNotificationEvent["origin"] {
  if (!message) return "unknown";
  if (message.scheduledTaskId) return "automation";
  const origin = readMessageOrigin({ text: message.text ?? "", context: message.context });
  if (message.notification || origin?.source === "worker-notification") return "routed";
  if (message.senderThreadId || origin?.source === "thread-send" || message.createdBy === "agent")
    return "worker";
  return message.createdBy === "user" &&
    (message.creationSource === "web" || message.creationSource === "mobile")
    ? "human"
    : "unknown";
}
export function threadNotificationEvent(
  thread: Pick<
    OrchestrationV2ThreadShell,
    | "notificationSuperseded"
    | "notificationDisposition"
    | "notificationOrigin"
    | "notificationRequestId"
    | "latestRunId"
    | "latestRunCompletedAt"
    | "pendingRuntimeRequest"
    | "hasActionableProposedPlan"
    | "status"
    | "updatedAt"
    | "lastError"
  >,
): ThreadNotificationEvent | null {
  const base = {
    origin: thread.notificationOrigin ?? "unknown",
    occurredAt: DateTime.formatIso(thread.latestRunCompletedAt ?? thread.updatedAt),
  };
  const request = thread.pendingRuntimeRequest;
  if (request && request.kind !== "auth_refresh")
    return {
      ...base,
      kind: request.kind === "user_input" ? "question" : "approval",
      identity: request.id,
      occurredAt: DateTime.formatIso(request.createdAt),
    };
  if (thread.hasActionableProposedPlan)
    return {
      ...base,
      kind: "decision",
      identity: thread.notificationRequestId ?? thread.latestRunId ?? "unknown-plan",
    };
  if (thread.notificationSuperseded) return null;
  if (thread.status === "failed")
    return {
      ...base,
      kind: "error",
      identity: thread.latestRunId ?? "unknown-error",
      errorReason: thread.lastError?.trim().split(/\r?\n/)[0]?.slice(0, 120) || "Agent failed",
    };
  if (
    thread.notificationDisposition === "attention" &&
    thread.status === "completed" &&
    thread.latestRunId
  )
    return { ...base, kind: "attention", identity: thread.latestRunId };
  if (thread.notificationDisposition === "quiet") return null;
  if (thread.status !== "completed" || !thread.latestRunId || !thread.latestRunCompletedAt)
    return null;
  return { ...base, kind: "reply", identity: thread.latestRunId };
}
/** Descendant/background tasks do not supersede an ended human turn. */
export function threadNotificationBusy(
  thread: Pick<OrchestrationV2ThreadShell, "activeRunId" | "activityRunStatus" | "status">,
): boolean {
  return (
    thread.activeRunId !== null ||
    thread.activityRunStatus != null ||
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.status)
  );
}
export function groupedNotificationTitle(events: ReadonlyArray<ThreadNotificationEvent>): string {
  return `${events.length} ${events.every((event) => event.kind === "reply") ? "replies ready" : "need you"}`;
}

/** Only the final nonempty line can declare completion disposition. */
export function notificationDispositionForReply(
  text: string | null | undefined,
): "quiet" | "attention" | null {
  const match = /(?:^|\n)T3_NOTIFY:\s*(quiet|attention)\s*$/.exec(text?.trim() ?? "");
  return match ? (match[1] as "quiet" | "attention") : null;
}
