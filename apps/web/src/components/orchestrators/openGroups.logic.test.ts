import { describe, expect, it } from "vite-plus/test";

import { groupOpen, setGroupOpen, toggleKey } from "./openGroups.logic";

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

describe("groupOpen", () => {
  it("follows the default until the user chooses, then keeps the choice when the default changes", () => {
    let stored: ReadonlyArray<string> = [];
    expect(groupOpen(stored, "band", true)).toBe(true);
    stored = setGroupOpen(stored, "band", false);
    // The band's default flips to open (a task now waits on Brad); the user's close stands.
    expect(groupOpen(stored, "band", true)).toBe(false);
    stored = setGroupOpen(stored, "band", true);
    expect(groupOpen(stored, "band", false)).toBe(true);
    expect(stored).toEqual(["open:band"]);
  });

  it("keeps choices for other groups apart", () => {
    const stored = setGroupOpen(setGroupOpen([], "a", true), "b", false);
    expect(groupOpen(stored, "a", false)).toBe(true);
    expect(groupOpen(stored, "b", true)).toBe(false);
    expect(groupOpen(stored, "c", true)).toBe(true);
  });
});
