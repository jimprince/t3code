import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
/** Also runs inside native serialized dispatch, so settlement/new work cannot race delivery. */
export function legacyNoticeCanStart(
  projection: OrchestrationV2ThreadProjection,
  expected: DateTime.Utc,
): boolean {
  const latest = projection.runs.reduce<(typeof projection.runs)[number] | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  return (
    DateTime.toEpochMillis(projection.thread.updatedAt) === DateTime.toEpochMillis(expected) &&
    projection.thread.archivedAt === null &&
    projection.thread.deletedAt === null &&
    projection.thread.settledOverride !== "settled" &&
    projection.thread.snoozedUntil == null &&
    !projection.runtimeRequests.some((request) => request.status === "pending") &&
    !projection.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) &&
    !["interrupted", "failed", "cancelled"].includes(latest?.status ?? "idle")
  );
}
