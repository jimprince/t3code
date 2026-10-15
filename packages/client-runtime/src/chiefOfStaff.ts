import type {
  DashboardAttention,
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

/** Fields the title fallback ranks on; all optional so any thread shell shape qualifies. */
interface DeskCandidateRank {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null | undefined;
  readonly runtime?: { readonly status: string } | null | undefined;
}

/**
 * Resolve the desk across every connected environment. An existing explicit preference wins, in
 * the order given; a stale one (missing or archived thread) falls through so it cannot hide a
 * valid one. With no usable preference, the exact-title match runs over all environments, because
 * the desk often lives on a remote whose server has no preference set. Several threads can share
 * the title (old failed desks stay around), so one is chosen deterministically: not failed, then
 * pinned, then on the primary environment, then most recently updated, then the larger id.
 */
export function selectScopedChiefOfStaffThread<
  T extends DeskCandidateRank & {
    readonly title: string;
    readonly archivedAt: unknown;
    readonly deletedAt?: unknown;
  },
>(input: {
  readonly threads: readonly T[];
  readonly preferred: readonly ScopedThreadRef[];
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ScopedThreadRef | null {
  for (const preferred of input.preferred) {
    const thread = selectChiefOfStaffThread(
      input.threads.filter((candidate) => candidate.environmentId === preferred.environmentId),
      preferred.threadId,
    );
    if (thread) return { environmentId: thread.environmentId, threadId: thread.id };
  }
  let best: T | null = null;
  for (const candidate of input.threads) {
    if (selectChiefOfStaffThread([candidate], null) === null) continue;
    if (best === null || compareDeskCandidates(candidate, best, input.primaryEnvironmentId) > 0) {
      best = candidate;
    }
  }
  return best ? { environmentId: best.environmentId, threadId: best.id } : null;
}

/** Positive when `candidate` is the better desk. */
function compareDeskCandidates(
  candidate: DeskCandidateRank,
  best: DeskCandidateRank,
  primaryEnvironmentId: EnvironmentId | null,
): number {
  const healthy = (thread: DeskCandidateRank) =>
    thread.runtime?.status !== "failed" && thread.runtime?.status !== "error";
  const pinned = (thread: DeskCandidateRank) => thread.pinnedAt != null;
  const primary = (thread: DeskCandidateRank) => thread.environmentId === primaryEnvironmentId;
  for (const rank of [healthy, pinned, primary]) {
    if (rank(candidate) !== rank(best)) return rank(candidate) ? 1 : -1;
  }
  const byUpdate = Date.parse(candidate.updatedAt) - Date.parse(best.updatedAt);
  if (byUpdate !== 0 && !Number.isNaN(byUpdate)) return byUpdate;
  return candidate.id > best.id ? 1 : candidate.id < best.id ? -1 : 0;
}

/**
 * Environment-local dashboard attention already excludes closed and answered decisions. The count
 * runs each project's attention through `keep` (the Dashboard's live-request filter) so the row,
 * the tray header and the decision pager all count the same list.
 */
export function selectChiefOfStaffSummary(input: {
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly dashboard: DashboardSnapshot | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly keep?: (
    attention: ReadonlyArray<DashboardAttention>,
  ) => ReadonlyArray<DashboardAttention>;
}) {
  const { thread, dashboard, projection, keep } = input;
  const waiting =
    dashboard?.projects.reduce(
      (sum, project) => sum + (keep ? keep(project.attention) : project.attention).length,
      0,
    ) ?? 0;
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
