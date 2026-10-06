import { describe, expect, it } from "vite-plus/test";
import { toCodexNativeGoalSummary } from "./CodexNativeGoal.ts";

describe("native goal status", () => {
  it("keeps V1 status labels and valid token usage", () => {
    for (const [status, expected] of [
      ["active", "active"],
      ["paused", "paused"],
      ["blocked", "blocked"],
      ["complete", "completed"],
      ["usageLimited", "blocked"],
      ["budgetLimited", "blocked"],
      ["unknown", "blocked"],
    ]) {
      expect(
        toCodexNativeGoalSummary({
          objective: " Ship it ",
          status: status!,
          tokensUsed: 12,
          tokenBudget: 100,
        }),
      ).toEqual({ objective: "Ship it", status: expected, tokensUsed: 12, tokenBudget: 100 });
    }
  });
  it("discards empty objectives and invalid token counts", () => {
    expect(toCodexNativeGoalSummary({ objective: "  ", status: "active" })).toBeUndefined();
    expect(
      toCodexNativeGoalSummary({
        objective: "ship",
        status: "active",
        tokensUsed: -1,
        tokenBudget: 1.5,
      }),
    ).toEqual({ objective: "ship", status: "active" });
  });
});
