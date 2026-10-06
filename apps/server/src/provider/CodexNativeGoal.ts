import type { CodexNativeGoalSummary } from "@t3tools/contracts";

export function toCodexNativeGoalSummary(goal: {
  readonly objective: string;
  readonly status: string;
  readonly tokensUsed?: number;
  readonly tokenBudget?: number | null;
}): CodexNativeGoalSummary | undefined {
  const objective = goal.objective.trim();
  if (objective.length === 0) {
    return undefined;
  }
  const status: CodexNativeGoalSummary["status"] =
    goal.status === "complete"
      ? "completed"
      : goal.status === "usageLimited" || goal.status === "budgetLimited"
        ? "blocked"
        : goal.status === "active" || goal.status === "paused" || goal.status === "blocked"
          ? goal.status
          : "blocked";
  const nonNegativeInteger = (value: number | null | undefined) =>
    typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
  const tokensUsed = nonNegativeInteger(goal.tokensUsed);
  const tokenBudget = nonNegativeInteger(goal.tokenBudget);
  return {
    objective,
    status,
    ...(tokensUsed !== undefined ? { tokensUsed } : {}),
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
  };
}
