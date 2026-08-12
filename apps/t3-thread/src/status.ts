import type { AgentStatus, OrchestrationThread, OrchestrationThreadShell } from "./types.js";

export function classifyThread(
  thread: OrchestrationThread | OrchestrationThreadShell,
): AgentStatus {
  if (thread.archivedAt) {
    return {
      state: "archived",
      reason: "thread is archived",
    };
  }

  const hasActionableProposedPlan =
    "hasActionableProposedPlan" in thread
      ? thread.hasActionableProposedPlan
      : thread.proposedPlans.some((plan) => !plan.implementedAt);
  if (hasActionableProposedPlan) {
    return {
      state: "needs-plan",
      reason: "plan is ready for action",
    };
  }

  if ("hasPendingApprovals" in thread && thread.hasPendingApprovals) {
    return {
      state: "needs-approval",
      reason: "approval request is pending",
    };
  }

  if ("hasPendingUserInput" in thread && thread.hasPendingUserInput) {
    return {
      state: "needs-input",
      reason: "user input is pending",
    };
  }

  if (thread.session?.status === "error" || thread.latestTurn?.state === "error") {
    return {
      state: "error",
      reason: thread.session?.lastError || "turn failed",
    };
  }

  if (
    thread.latestTurn?.state === "running" ||
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    (thread.session?.activeTurnId ?? null) !== null
  ) {
    return {
      state: "running",
      reason: "turn is running",
    };
  }

  if (thread.latestTurn?.state === "interrupted" || thread.session?.status === "interrupted") {
    return {
      state: "interrupted",
      reason: "turn was interrupted",
    };
  }

  if (thread.latestTurn?.state === "completed") {
    return {
      state: "completed",
      reason: "latest turn completed",
    };
  }

  return {
    state: "idle",
    reason: thread.session?.status ? `session ${thread.session.status}` : "no active turn",
  };
}

export function formatThreadLine(thread: OrchestrationThread | OrchestrationThreadShell): string {
  const status = classifyThread(thread);
  return [thread.id, `[${status.state}]`, thread.title, thread.projectId, status.reason].join(" ");
}
