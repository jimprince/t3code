import { describe, expect, it } from "vite-plus/test";

import { parseComposerGoalSlashCommand } from "./composer-logic";

describe("parseComposerGoalSlashCommand", () => {
  it("parses /goal status", () => {
    expect(parseComposerGoalSlashCommand(" /goal ")).toEqual({ type: "status" });
  });

  it("parses /goal clear aliases", () => {
    expect(parseComposerGoalSlashCommand("/goal stop")).toEqual({ type: "clear" });
  });

  it("parses /goal condition text", () => {
    expect(parseComposerGoalSlashCommand("/goal make lint pass")).toEqual({
      type: "set",
      goal: "make lint pass",
    });
  });
});
