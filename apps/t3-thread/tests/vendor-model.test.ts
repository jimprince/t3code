import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

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
