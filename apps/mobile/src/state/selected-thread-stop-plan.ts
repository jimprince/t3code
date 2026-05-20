import type { EnvironmentScopedThreadShell } from "@t3tools/client-runtime";
import type { EnvironmentId, TurnId } from "@t3tools/contracts";

interface StopPlanSessionLike {
  readonly status?: string | null;
  readonly activeTurnId?: TurnId | null;
}

export interface SelectedThreadStopPlan {
  readonly environmentId: EnvironmentId;
  readonly threadId: EnvironmentScopedThreadShell["id"];
  readonly turnId?: TurnId;
  readonly shouldInterrupt: boolean;
  readonly shouldClearQueue: boolean;
}

export function resolveSelectedThreadStopPlan(input: {
  readonly selectedThreadShell: {
    readonly environmentId: EnvironmentScopedThreadShell["environmentId"];
    readonly id: EnvironmentScopedThreadShell["id"];
    readonly session?: StopPlanSessionLike | null;
  } | null;
  readonly selectedThreadDetail: {
    readonly session?: StopPlanSessionLike | null;
  } | null;
  readonly queueCount: number;
}): SelectedThreadStopPlan | null {
  const { selectedThreadShell, selectedThreadDetail, queueCount } = input;
  if (!selectedThreadShell) {
    return null;
  }

  const session: StopPlanSessionLike | null =
    selectedThreadDetail?.session ?? selectedThreadShell.session ?? null;
  const shouldInterrupt = session?.status === "running" || session?.status === "starting";
  const shouldClearQueue = queueCount > 0;
  if (!shouldInterrupt && !shouldClearQueue) {
    return null;
  }

  return {
    environmentId: selectedThreadShell.environmentId,
    threadId: selectedThreadShell.id,
    ...(shouldInterrupt && session?.activeTurnId ? { turnId: session.activeTurnId } : {}),
    shouldInterrupt,
    shouldClearQueue,
  };
}
