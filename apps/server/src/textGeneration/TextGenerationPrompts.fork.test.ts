import { describe, expect, it } from "vite-plus/test";

import { buildGoalEvaluationPrompt } from "./TextGenerationPrompts.ts";

describe("buildGoalEvaluationPrompt", () => {
  it("requires transcript-visible evidence only", () => {
    const result = buildGoalEvaluationPrompt({
      goal: "Fix the failing lint check",
      transcript: "USER: fix lint\nASSISTANT: I will fix it",
    });

    expect(result.prompt).toContain("Use only the transcript-visible evidence");
    expect(result.prompt).toContain("Fix the failing lint check");
    expect(result.prompt).toContain("USER: fix lint");
  });
});
