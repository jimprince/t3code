import type {
  DashboardSnapshot,
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ScopedThreadRef,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

/** Exact front desk titles keep the fallback from choosing Chief of Staff Operations. */
export function selectChiefOfStaffThread(
  threads: readonly OrchestrationV2ThreadShell[],
  preferredId: ThreadId | null,
) {
  const available = threads.filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null,
  );
  if (preferredId !== null) return available.find((thread) => thread.id === preferredId) ?? null;
  return (
    available.find((thread) => /^(chief[ -]of[ -]staff|front desk)$/i.test(thread.title.trim())) ??
    null
  );
}

/** Environment-local dashboard attention already excludes closed and answered decisions. */
export function selectChiefOfStaffSummary(input: {
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly dashboard: DashboardSnapshot | null;
  readonly projection: OrchestrationV2ThreadProjection | null;
}) {
  const { thread, dashboard, projection } = input;
  const openDecisions = new Set(
    dashboard?.projects.flatMap((project) =>
      project.attention
        .filter((attention) => attention.kind === "decision")
        .map((attention) => attention.id),
    ) ?? [],
  );
  // A newer user message must never replace the last assistant reply timestamp.
  let lastReplyAt =
    thread?.latestVisibleMessage?.role === "assistant"
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
    openDecisionCount: openDecisions.size,
    /** ISO instant; the UI formats HH:MM in the device's local time. */
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

/** Bind to existing app atoms so the tray shares settings, shell, dashboard and thread streams. */
export function createChiefOfStaffSummaryAtoms(options: {
  readonly settings: (id: EnvironmentId) => Atom.Atom<ServerSettings | null>;
  readonly threads: (id: EnvironmentId) => Atom.Atom<readonly OrchestrationV2ThreadShell[]>;
  readonly dashboard: (
    id: EnvironmentId,
  ) => Atom.Atom<{ readonly snapshot: DashboardSnapshot | null }>;
  readonly projection: (ref: ScopedThreadRef) => Atom.Atom<OrchestrationV2ThreadProjection | null>;
}) {
  return Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const thread = selectChiefOfStaffThread(
        get(options.threads(environmentId)),
        get(options.settings(environmentId))?.chiefOfStaffThreadId ?? null,
      );
      return selectChiefOfStaffSummary({
        thread,
        dashboard: get(options.dashboard(environmentId)).snapshot,
        projection: thread ? get(options.projection({ environmentId, threadId: thread.id })) : null,
      });
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`chief-of-staff:${environmentId}`)),
  );
}

/** Each React client binds its existing useAtomValue without adding React to client-runtime. */
export function createChiefOfStaffHooks(
  summary: ReturnType<typeof createChiefOfStaffSummaryAtoms>,
  useAtomValue: (atom: Atom.Atom<ChiefOfStaffSummary>) => ChiefOfStaffSummary,
) {
  function useChiefOfStaffSummary(environmentId: EnvironmentId) {
    return useAtomValue(summary(environmentId));
  }
  return { useChiefOfStaffSummary };
}
