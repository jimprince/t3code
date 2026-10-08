import { describe, expect, it } from "vite-plus/test";

import { toggleKey } from "./openGroups.logic";

describe("toggleKey", () => {
  it("opens a collapsed group without disturbing the others", () => {
    expect(toggleKey(["fork.30"], "fork.31")).toEqual(["fork.30", "fork.31"]);
  });

  it("collapses an open group again", () => {
    expect(toggleKey(["fork.30", "fork.31"], "fork.30")).toEqual(["fork.31"]);
  });

  it("treats the outside-a-release group's empty key like any other", () => {
    expect(toggleKey(toggleKey([], ""), "")).toEqual([]);
  });
});
