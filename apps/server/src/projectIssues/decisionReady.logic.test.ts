import { describe, expect, it } from "vite-plus/test";
import { decisionReadyParts, validateDecisionReady } from "./decisionReady.logic.ts";

// Product's backfill format: explanation, explicit judging location, choices and recommendation.
const ready = `Built the wider Chief of Staff review strip so the plan is readable inline.
What you are judging and where: Judge the plan width in your Dev app after Update #355, or see the linked 644 px screenshot.
Option A: Approve the wider strip
Option B: Keep the current width
Recommended: Option A`;
const title = "Widen the plan in the Chief of Staff tray";

describe("Brad-facing producer contract", () => {
  it("warns when the judging/location line is blank rather than consuming the next option", () => {
    const body =
      "Built the wider review strip for testing.\nWhat you are judging and where:\nOption A: Passed\nOption B: Failed\nRecommended: Option A";
    expect(decisionReadyParts(title, body).judgingWhere).toBeNull();
    expect(validateDecisionReady(title, body)).toMatchObject({
      error: null,
      warnings: [expect.stringContaining("What you are judging and where:")],
    });
  });
  it("parses the four parts without repeating the title or mixing the location into the summary", () => {
    const parts = decisionReadyParts(title, ready);
    expect(parts.summary).toBe(
      "Built the wider Chief of Staff review strip so the plan is readable inline.",
    );
    expect(parts.judgingWhere).toBe(
      "Judge the plan width in your Dev app after Update #355, or see the linked 644 px screenshot.",
    );
    expect(parts.recommended).toBe("Option A");
    expect(parts.options.map((option) => option.text)).toEqual([
      "Approve the wider strip",
      "Keep the current width",
    ]);
    expect(parts.asksNothingYet).toBe(false);
    expect(validateDecisionReady(title, ready)).toEqual({ error: null, warnings: [] });
  });
  it("refuses missing/title-only summaries even when choices and judging metadata are present", () => {
    for (const body of [
      "",
      title,
      `${title}.`,
      `${title}\nWhat you are judging and where: Dev after Update #355\nOption A: Yes\nOption B: No\nRecommended: Option A`,
    ]) {
      expect(decisionReadyParts(title, body)).toMatchObject({ summary: "", asksNothingYet: true });
      expect(validateDecisionReady(title, body).error).toContain(
        "plain sentence explaining what changed",
      );
    }
  });
  it("warns but accepts an explanation missing the optional location, recommendation and choices", () => {
    const result = validateDecisionReady(
      title,
      "Built the wider review strip with the complete plan.",
    );
    expect(result.error).toBeNull();
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join("\n")).toContain("What you are judging and where:");
    expect(result.warnings.join("\n")).toContain("Recommended:");
    expect(result.warnings.join("\n")).toContain("Option A:");
  });
});
