import type {
  DashboardSnapshot,
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Exact front desk titles keep the fallback from choosing Chief of Staff Operations. */
export function selectChiefOfStaffThread<
  T extends {
    readonly id: ThreadId;
    readonly title: string;
    readonly archivedAt: unknown;
    readonly deletedAt?: unknown;
  },
>(threads: readonly T[], preferredId: ThreadId | null) {
  const available = threads.filter(
    (thread) =>
      thread.archivedAt === null && (thread.deletedAt === undefined || thread.deletedAt === null),
  );
  if (preferredId !== null) return available.find((thread) => thread.id === preferredId) ?? null;
  return (
    available.find((thread) => /^(chief[ -]of[ -]staff|front desk)$/i.test(thread.title.trim())) ??
    null
  );
}

/** Resolve a configured environment first; title discovery belongs to the primary environment. */
export function selectScopedChiefOfStaffThread<
  T extends {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
    readonly title: string;
    readonly archivedAt: unknown;
    readonly deletedAt?: unknown;
  },
>(input: {
  readonly threads: readonly T[];
  readonly preferred: ScopedThreadRef | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ScopedThreadRef | null {
  const environmentId = input.preferred?.environmentId ?? input.primaryEnvironmentId;
  const thread = selectChiefOfStaffThread(
    input.threads.filter((candidate) => candidate.environmentId === environmentId),
    input.preferred?.threadId ?? null,
  );
  return thread ? { environmentId: thread.environmentId, threadId: thread.id } : null;
}

/** Environment-local dashboard attention already excludes closed and answered decisions. */
export function selectChiefOfStaffSummary(input: {
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly dashboard: DashboardSnapshot | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
}) {
  const { thread, dashboard, projection } = input;
  const waiting =
    dashboard?.projects.reduce((sum, project) => sum + project.attention.length, 0) ?? 0;
  // A newer user message must never replace the last assistant reply timestamp.
  let lastReplyAt =
    thread?.latestVisibleMessage?.role === "assistant" &&
    thread.latestVisibleMessage.text.trim().length > 0
      ? thread.latestVisibleMessage.updatedAt
      : null;
  if (thread && projection?.thread.id === thread.id) {
    for (const message of projection.messages) {
      if (
        message.threadId !== thread.id ||
        message.role !== "assistant" ||
        message.text.trim().length === 0
      )
        continue;
      if (
        lastReplyAt === null ||
        DateTime.toEpochMillis(message.updatedAt) > DateTime.toEpochMillis(lastReplyAt)
      ) {
        lastReplyAt = message.updatedAt;
      }
    }
  }
  const status = thread?.activityRunStatus ?? thread?.status;
  return {
    thread,
    openDecisionCount: waiting,
    /** ISO instant, formatted in the device's local time by each client. */
    lastReplyAt: lastReplyAt === null ? null : DateTime.formatIso(lastReplyAt),
    isBusy:
      status === "preparing" ||
      status === "queued" ||
      status === "starting" ||
      status === "running" ||
      status === "waiting",
  };
}

export type ChiefOfStaffSummary = ReturnType<typeof selectChiefOfStaffSummary>;
