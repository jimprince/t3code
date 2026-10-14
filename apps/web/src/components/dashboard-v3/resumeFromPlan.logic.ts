import type { ThreadResumeRefusalReason } from "@t3tools/contracts";

/** Plain words for each reason the server refuses to resume a thread. */
const REFUSAL_TEXT: Record<ThreadResumeRefusalReason, string> = {
  still_running: "Still running",
  plan_complete: "Plan already complete",
  no_plan: "No plan to resume",
  not_failed: "Thread did not fail",
};

/** The toast text for a failed resume: a typed refusal in plain words, else the error's own message. */
export function resumeFailureText(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const { _tag, reason, message } = error as {
      _tag?: unknown;
      reason?: unknown;
      message?: unknown;
    };
    if (_tag === "ThreadResumeError" && typeof reason === "string" && reason in REFUSAL_TEXT)
      return REFUSAL_TEXT[reason as ThreadResumeRefusalReason];
    if (typeof message === "string" && message) return message;
  }
  return "Could not resume";
}

/** Dashboard rows for a thread's own to-do list carry this id prefix. */
const THREAD_PLAN_TASK_PREFIX = "thread-plan:";
export const isThreadPlanTaskId = (id: string) => id.startsWith(THREAD_PLAN_TASK_PREFIX);
