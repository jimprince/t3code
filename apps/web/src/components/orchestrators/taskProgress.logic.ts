import {
  isThreadWorking,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";

/**
 * "3 of 5 steps" for a task card: the to-do list of the task's linked thread that
 * is working right now. Null when none is, so a finished thread's stale list
 * never shows.
 */
export function taskStepProgress(
  issue: Pick<ProjectIssue, "linkedThreadIds">,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
): string | null {
  let best: { readonly completed: number; readonly total: number } | null = null;
  for (const threadId of issue.linkedThreadIds) {
    const thread = threadsById.get(threadId);
    const progress = thread?.todoProgress;
    if (thread === undefined || !progress || progress.total === 0 || !isThreadWorking(thread)) {
      continue;
    }
    if (best === null || progress.total - progress.completed > best.total - best.completed) {
      best = progress;
    }
  }
  return best === null ? null : `${best.completed} of ${best.total} steps`;
}
