import type { OrchestrationV2ThreadShell, ThreadFilePlan } from "@t3tools/contracts";
import { threadResumeRefusal } from "@t3tools/shared/threadPlan";
export const isThreadResumable = (
  shell: Pick<OrchestrationV2ThreadShell, "todoProgress" | "planResumeState"> &
    Partial<Pick<OrchestrationV2ThreadShell, "settledOverride" | "filePlan">>,
): boolean => threadResumeRefusal(shell) === null;

/**
 * Overlays a thread's PLAN.md progress (from the dashboard snapshot) on its shell, as the server
 * does before it decides eligibility: the file plan wins, and native todo_list progress is the
 * fallback only when no file plan maps to the thread.
 */
export function withFilePlan<S extends object>(shell: S, filePlan: ThreadFilePlan | undefined) {
  return filePlan
    ? {
        ...shell,
        filePlan,
        todoProgress: {
          completed: filePlan.done,
          total: filePlan.total,
          currentStep: filePlan.currentStep,
        },
      }
    : shell;
}
