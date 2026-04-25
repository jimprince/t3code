import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ClaudeModelOptions } from "../src/vendor/t3contracts/model.js";

describe("vendored model schemas", () => {
  it("accepts live Claude effort values such as xhigh", () => {
    const parsed = Schema.decodeSync(ClaudeModelOptions)({
      effort: "xhigh",
      contextWindow: "200k",
    });

    expect(parsed.effort).toBe("xhigh");
    expect(parsed.contextWindow).toBe("200k");
  });
});
