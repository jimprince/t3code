import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { DecisionsToolkit } from "./tools.ts";

const answer = Schema.decodeUnknownSync(DecisionsToolkit.tools.decision_answer.parametersSchema);
const ready = Schema.decodeUnknownSync(DecisionsToolkit.tools.request_ready.parametersSchema);

describe("decision producer MCP contract", () => {
  it("accepts reject and free text on the shared answer path", () => {
    expect(
      answer({ reference: "355", decision: "reject", note: "Fix the boundary" }).decision,
    ).toBe("reject");
    expect(answer({ reference: "355", decision: "answer", answer: "Keep testing" }).decision).toBe(
      "answer",
    );
  });
  it("shares the ready producer options schema and requires a summary", () => {
    expect(
      ready({
        reference: "355",
        summary: "Built the smaller output for review.",
        options: [
          { text: "Ship", recommended: true },
          { text: "Wait", recommended: false },
        ],
      }).options,
    ).toHaveLength(2);
    expect(() =>
      ready({
        reference: "355",
        summary: "Built the smaller output.",
        options: [{ text: "Only", recommended: true }],
      }),
    ).toThrow();
    expect(() => ready({ reference: "355" })).toThrow();
  });
});
