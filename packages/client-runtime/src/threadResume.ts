import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { threadResumeRefusal } from "@t3tools/shared/threadPlan";
export const isThreadResumable = (
  shell: Pick<OrchestrationV2ThreadShell, "todoProgress" | "planResumeState"> &
    Partial<Pick<OrchestrationV2ThreadShell, "settledOverride" | "filePlan">>,
): boolean => threadResumeRefusal(shell) === null;
