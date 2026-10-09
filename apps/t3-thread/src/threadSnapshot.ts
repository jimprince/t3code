import { DateTime } from "effect";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import type { OrchestrationThreadShell } from "./types.js";

export function summarizeThreadQueue(projection: Pick<OrchestrationV2ThreadProjection, "runs">) {
  let queuedCount = 0;
  let heldCount = 0;
  let oldestQueuedAt: string | null = null;
  for (const run of projection.runs) {
    if (run.status !== "queued") continue;
    queuedCount++;
    if (run.queueHeld === true) heldCount++;
    const at = DateTime.formatIso(run.requestedAt);
    if (oldestQueuedAt === null || at < oldestQueuedAt) oldestQueuedAt = at;
  }
  return { queuedCount, heldCount, oldestQueuedAt };
}

export type ThreadQueueSummary = ReturnType<typeof summarizeThreadQueue>;
export type ThreadSnapshotRow = ReturnType<typeof snapshotRow>;
function snapshotRow(
  thread: OrchestrationThreadShell,
  queue: ThreadQueueSummary | null,
  queueError: string | null,
) {
  return {
    id: thread.id,
    title: thread.title,
    projectId: thread.projectId,
    parent: thread.remoteParent ?? thread.parentThreadId ?? null,
    pinned: thread.pinnedAt != null,
    settled: thread.settledOverride === "settled",
    archived: thread.archivedAt != null,
    status: thread.status ?? "idle",
    activeRunId: thread.activeRunId ?? null,
    latestRunStartedAt: thread.latestRunStartedAt ?? null,
    updatedAt: thread.updatedAt,
    queuedCount: queue?.queuedCount ?? null,
    heldCount: queue?.heldCount ?? null,
    oldestQueuedAt: queue?.oldestQueuedAt ?? null,
    ...(queueError === null ? {} : { queueError }),
  };
}

/** Fixed batches bound retained projections/results even when stdout is slow. No parent traversal. */
export async function streamThreadSnapshot(
  threads: readonly OrchestrationThreadShell[],
  readQueue: (id: string, signal: AbortSignal) => Promise<ThreadQueueSummary>,
  write: (row: ThreadSnapshotRow) => Promise<void>,
  options: { concurrency?: number; timeoutMs?: number; activeOnly?: boolean } = {},
): Promise<void> {
  const concurrency = options.concurrency ?? 2;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new Error("Queue concurrency must be between 1 and 8.");
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("Queue timeout must be positive.");
  for (let offset = 0; offset < threads.length; offset += concurrency) {
    const rows = await Promise.all(
      threads.slice(offset, offset + concurrency).map(async (thread) => {
        if (options.activeOnly && !thread.activeRunId && thread.status !== "queued") {
          return snapshotRow(
            thread,
            null,
            "skipped by --active-only; shell has no active run or queue hint",
          );
        }
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(new Error(`Queue read timed out after ${timeoutMs} ms`)),
          timeoutMs,
        );
        try {
          return snapshotRow(thread, await readQueue(thread.id, controller.signal), null);
        } catch (error) {
          const reason = controller.signal.aborted ? controller.signal.reason : error;
          return snapshotRow(
            thread,
            null,
            (reason instanceof Error ? reason.message : String(reason)).slice(0, 1000),
          );
        } finally {
          clearTimeout(timeout);
        }
      }),
    );
    for (const row of rows) await write(row);
  }
}
