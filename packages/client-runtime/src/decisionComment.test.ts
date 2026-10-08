import { describe, expect, it } from "vite-plus/test";

import {
  answerSentences,
  isNotAnswer,
  parseDecisionComment,
  readyComment,
} from "./decisionComment.ts";

describe("parseDecisionComment", () => {
  it("reads the options, the recommendation and the rest of a ready comment", () => {
    const parsed = parseDecisionComment(
      "Ready for your call.\nOption A: Rework the jaw now\nOption B: Wait for the scale test\nRecommended: A",
    );
    expect(parsed.options.map((option) => option.label)).toEqual(["Option A", "Option B"]);
    expect(parsed.recommendation).toBe("A");
    expect(parsed.detail).toBe("Ready for your call.");
  });

  it("is a plain approval when fewer than two options are listed", () => {
    expect(parseDecisionComment("Plan is ready.\nOption A: only one").options).toEqual([]);
  });

  it("reads the latest comment of an issue", () => {
    expect(
      readyComment({
        latestComment: { author: "a", body: "Option A: x\nOption B: y", createdAt: "z" },
      }).options,
    ).toHaveLength(2);
    expect(readyComment({}).options).toEqual([]);
  });
});

describe("answer helpers", () => {
  it("cuts an answer to whole sentences", () => {
    expect(answerSentences("**Yes.** It works! And more. Even more.", 2)).toBe("Yes. It works!");
  });

  it("never treats a progress note, curator note or Brad's follow-up as an answer", () => {
    expect(isNotAnswer("Progress: started")).toBe(true);
    expect(isNotAnswer("<!-- x -->curator: moved")).toBe(true);
    expect(isNotAnswer("The set is 27 mm.")).toBe(false);
  });
});
