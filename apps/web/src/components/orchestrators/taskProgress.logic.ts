import {
  isThreadWorking,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";

/**
 * Steps done and total of the task's linked thread that is working right now (the
 * one with the most steps left). Null when none is, so a finished thread's stale
 * list never counts.
 */
export function taskSteps(
  issue: Pick<ProjectIssue, "linkedThreadIds">,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
): { readonly completed: number; readonly total: number } | null {
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
  return best;
}

/** "3 of 5 steps" for a task card, from taskSteps. */
export function taskStepProgress(
  issue: Pick<ProjectIssue, "linkedThreadIds">,
  threadsById: ReadonlyMap<string, OrchestratorThreadShell>,
): string | null {
  const steps = taskSteps(issue, threadsById);
  return steps === null ? null : `${steps.completed} of ${steps.total} steps`;
}
