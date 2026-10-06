import type { ThreadRunSummary, ThreadRuntimeSummary } from "../state/models.ts";

/** A terminal run is settled only after runtime ownership has also been released. */
export function isRecoveredRunSettled(
  run: Pick<ThreadRunSummary, "runId" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "activeRunId"> | null,
): boolean {
  if (run === null) return false;
  if (["preparing", "queued", "starting", "running", "waiting"].includes(run.status)) return false;
  return runtime?.activeRunId !== run.runId;
}
