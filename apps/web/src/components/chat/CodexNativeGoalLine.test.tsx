import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { CodexNativeGoalLine } from "./CodexNativeGoalLine";

describe("CodexNativeGoalLine", () => {
  it("renders the native objective, status, and token budget compactly", () => {
    const markup = renderToStaticMarkup(
      <CodexNativeGoalLine
        goal={{
          objective: "Ship goal visibility",
          status: "active",
          tokensUsed: 1_200,
          tokenBudget: 4_000,
        }}
      />,
    );

    expect(markup).toContain("Goal: Ship goal visibility");
    expect(markup).toContain("Active · 1,200 / 4,000 tokens");
  });
});
