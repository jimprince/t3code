import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  ThreadResumeRefusalReason,
  ThreadTodoProgress,
} from "@t3tools/contracts";

/** Match the shell SQL ordering: newest run ordinal, then plan ID. */
export function latestThreadTodo(
  plans: OrchestrationV2ThreadProjection["plans"],
  runs: OrchestrationV2ThreadProjection["runs"],
) {
  const ordinals = new Map(runs.map((run) => [run.id, run.ordinal]));
  return plans
    .filter((plan) => plan.kind === "todo_list")
    .sort(
      (a, b) =>
        (b.runId === null ? -1 : (ordinals.get(b.runId) ?? -1)) -
          (a.runId === null ? -1 : (ordinals.get(a.runId) ?? -1)) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    )[0];
}
export function threadTodoProgress(
  plans: OrchestrationV2ThreadProjection["plans"],
  runs: OrchestrationV2ThreadProjection["runs"],
): ThreadTodoProgress | null {
  const plan = latestThreadTodo(plans, runs);
  if (!plan || plan.steps.length === 0) return null;
  const step =
    plan.steps.find((s) => s.status === "running") ??
    plan.steps.find((s) => s.status === "pending");
  return {
    completed: plan.steps.filter((s) => s.status === "completed").length,
    total: plan.steps.length,
    currentStep:
      step && step.status !== "completed"
        ? { id: step.id, text: step.text, status: step.status }
        : null,
  };
}
export function threadPlanResumeState(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerSessions" | "providerTurns">,
): NonNullable<OrchestrationV2ThreadShell["planResumeState"]> {
  const latestRun = [...projection.runs].sort((a, b) => b.ordinal - a.ordinal)[0];
  const sessions = [...projection.providerSessions].sort(
    (a, b) =>
      DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
  return {
    latestRunStatus: latestRun?.status ?? null,
    // Retained for wire compatibility; live work is represented by hasLiveTurn.
    hasLiveSession: false,
    hasLiveTurn:
      projection.providerTurns.some((t) => t.status === "running") ||
      projection.runs.some((r) =>
        ["preparing", "starting", "running", "waiting"].includes(r.status),
      ),
    failedSession: sessions[0]?.status === "error" && latestRun?.status !== "completed",
  };
}
export function threadResumeRefusal(
  shell: Pick<OrchestrationV2ThreadShell, "todoProgress" | "planResumeState"> &
    Partial<Pick<OrchestrationV2ThreadShell, "filePlan">> &
    Partial<Pick<OrchestrationV2ThreadShell, "settledOverride">>,
): ThreadResumeRefusalReason | null {
  if (shell.settledOverride === "settled") return "not_failed";
  const progress = shell.filePlan
    ? { completed: shell.filePlan.done, total: shell.filePlan.total }
    : shell.todoProgress;
  if (!progress || progress.total === 0) return "no_plan";
  if (progress.completed >= progress.total) return "plan_complete";
  const state = shell.planResumeState;
  if (state?.hasLiveTurn) return "still_running";
  if (!state || (state.latestRunStatus !== "failed" && state.latestRunStatus !== "interrupted"))
    return "not_failed";
  return null;
}
