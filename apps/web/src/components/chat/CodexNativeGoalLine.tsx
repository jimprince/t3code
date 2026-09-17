import type { CodexNativeGoalSummary } from "@t3tools/contracts";

const TOKEN_FORMATTER = new Intl.NumberFormat("en-US");

const STATUS_LABELS: Record<CodexNativeGoalSummary["status"], string> = {
  active: "Active",
  completed: "Completed",
  blocked: "Blocked",
  paused: "Paused",
};

function tokenSummary(goal: CodexNativeGoalSummary): string | null {
  if (goal.tokensUsed !== undefined && goal.tokenBudget !== undefined) {
    return `${TOKEN_FORMATTER.format(goal.tokensUsed)} / ${TOKEN_FORMATTER.format(goal.tokenBudget)} tokens`;
  }
  if (goal.tokensUsed !== undefined) {
    return `${TOKEN_FORMATTER.format(goal.tokensUsed)} tokens`;
  }
  if (goal.tokenBudget !== undefined) {
    return `${TOKEN_FORMATTER.format(goal.tokenBudget)} token budget`;
  }
  return null;
}

export function CodexNativeGoalLine({ goal }: { readonly goal: CodexNativeGoalSummary }) {
  const tokens = tokenSummary(goal);
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="min-w-0 truncate font-medium">Goal: {goal.objective}</span>
      <span className="shrink-0 text-muted-foreground">
        {STATUS_LABELS[goal.status]}
        {tokens ? ` · ${tokens}` : ""}
      </span>
    </span>
  );
}
