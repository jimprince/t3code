import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

/** GC must retain every execution resource, including commands left by completed runs. */
export function projectionHasWork(projection: OrchestrationV2ThreadProjection): boolean {
  if (
    projection.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return true;
  if (projection.runtimeRequests.some((request) => request.status === "pending")) return true;
  return (
    derivePendingBackgroundWork({
      latestRun: projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
        (latest, run) => (latest === null || run.ordinal > latest.ordinal ? run : latest),
        null,
      ),
      runs: projection.runs,
      providerThreads: projection.providerThreads,
      turnItems: projection.turnItems,
      activeProviderThreadId: projection.thread.activeProviderThreadId,
    }).length > 0
  );
}
