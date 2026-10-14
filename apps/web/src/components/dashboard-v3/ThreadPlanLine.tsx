import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { filePlanKey } from "@t3tools/client-runtime/dashboard/merge";
import { isThreadResumable, withFilePlan } from "@t3tools/client-runtime/thread-resume";
import {
  AuthOrchestrationOperateScope,
  type DashboardTask,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { useServerConfigs, useThreadShell, waitForThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { resumeThreadFromPlan } from "../../state/threadResume";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { cn } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useDashboardUi } from "./context";
import { resumeFailureText } from "./resumeFromPlan.logic";

/**
 * Resumes a stopped thread from its plan and opens the fresh thread. A second click while the
 * first is in flight is ignored; after it, the server returns the same thread.
 */
function useResumeFromPlan(environmentId: EnvironmentId) {
  const resume = useOrchestrationCommand(resumeThreadFromPlan, { reportFailure: false });
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  // A ref, not `pending`: a second click in the same frame still sees the old state.
  const inFlight = useRef(false);
  const start = async (threadId: ThreadId) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    try {
      const result = await resume({ environmentId, input: { threadId } });
      if (result._tag !== "Success") {
        toastManager.add({
          type: "error",
          title: resumeFailureText(squashAtomCommandFailure(result)),
        });
        return;
      }
      const ref = scopeThreadRef(environmentId, result.value.newThreadId);
      // The route treats a thread whose shell has not arrived as missing and leaves it.
      if (await waitForThreadShell(ref))
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
      else
        toastManager.add({
          type: "error",
          title: "Could not open the new thread",
          description: "It was created; open it from the sidebar.",
        });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, start };
}

/**
 * The line under a task row's title, for the thread the row names. A thread-plan row shows its
 * current step; any row whose thread is stopped with steps left shows a quiet "Stopped" and one
 * "Resume from plan" action, and an issue row whose thread is not stopped shows nothing extra. The
 * action is absent when the server lacks the capability or the connection cannot operate threads.
 * The thread's PLAN.md progress from the snapshot is overlaid on its shell first, and its current
 * step is preferred, as the server does; native todo_list progress is the fallback.
 */
export function ThreadPlanLine({
  environmentId,
  task,
  planRow,
  className,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: DashboardTask;
  /** The row is the thread's own plan, so its current step always shows. */
  readonly planRow: boolean;
  /** Placement in the row's grid. */
  readonly className?: string;
}) {
  const threadId = task.threadId;
  const filePlan = useDashboardUi().data.filePlans?.[filePlanKey(environmentId, threadId ?? "")];
  const shell = useThreadShell(threadId ? scopeThreadRef(environmentId, threadId) : null);
  const supported =
    useServerConfigs().get(environmentId)?.environment.capabilities.threadResumeFromPlan === true;
  const permitted = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const { pending, start } = useResumeFromPlan(environmentId);
  const stopped = shell !== null && isThreadResumable(withFilePlan(shell, filePlan));
  const step = filePlan ? (filePlan.currentStep?.text ?? null) : task.nextStep;
  if (!stopped && !(planRow && step)) return null;
  return (
    <span className={cn("flex min-w-0 items-baseline gap-x-2 text-muted-foreground", className)}>
      {stopped ? <span className="shrink-0">Stopped{step ? " ·" : ""}</span> : null}
      {step ? <span className="min-w-0 truncate">{step}</span> : null}
      {stopped && supported && permitted && threadId ? (
        <InlineButton className="ml-1" disabled={pending} onClick={() => void start(threadId)}>
          {pending ? "Resuming" : "Resume from plan"}
        </InlineButton>
      ) : null}
    </span>
  );
}
