import { describe, expect, it } from "vite-plus/test";

import { epicProgress, isEpic, parseEpicChecklist, parsePartOf } from "./epicProgress.logic.ts";

const issue = (
  number: number,
  overrides: Partial<{ body: string; labels: string[]; closed: boolean }> = {},
) => ({ number, body: "", labels: [] as string[], closed: false, ...overrides });

describe("isEpic", () => {
  it("reads ask:epic, and the older ask:plan unless a newer type label wins", () => {
    expect(isEpic(["ask", "ask:epic"])).toBe(true);
    expect(isEpic(["ASK:PLAN"])).toBe(true);
    expect(isEpic(["ask:plan", "ask:task"])).toBe(false);
    expect(isEpic(["ask:plan", "ask:epic"])).toBe(true);
    expect(isEpic(["ask:task"])).toBe(false);
  });
});

describe("parseEpicChecklist", () => {
  it("reads ticked and unticked #N items and ignores other lines", () => {
    expect(
      parseEpicChecklist(
        [
          "Port the fork.",
          "- [ ] #12 M1: rebase",
          "* [x] #13 M2",
          "  - [X] #14 nested",
          "- [ ] a plain task",
          "- #15 not a checkbox",
        ].join("\n"),
      ),
    ).toEqual([
      { number: 12, checked: false },
      { number: 13, checked: true },
      { number: 14, checked: true },
    ]);
  });
});

describe("parsePartOf", () => {
  it("matches only a body that starts with Part of #N", () => {
    expect(parsePartOf("Part of #109\n\nDetails")).toBe(109);
    expect(parsePartOf("\n  part of #7")).toBe(7);
    expect(parsePartOf("Details. Part of #109")).toBeNull();
    expect(parsePartOf(null)).toBeNull();
  });
});

describe("epicProgress", () => {
  it("counts checklist children, done when ticked or closed", () => {
    const progress = epicProgress([
      issue(1, { labels: ["ask:epic"], body: "- [x] #2\n- [ ] #3\n- [ ] #4\n- [ ] #5" }),
      issue(2),
      issue(3, { closed: true }),
      issue(4),
    ]);
    expect(progress.get(1)).toEqual({ done: 2, total: 4, remaining: [4, 5] });
    expect(progress.has(2)).toBe(false);
  });

  it("adds children that say Part of #N without a checklist line", () => {
    const progress = epicProgress([
      issue(1, { labels: ["ask:epic"], body: "- [ ] #2" }),
      issue(2),
      issue(3, { body: "Part of #1\n\nMore" }),
      issue(4, { body: "Part of #1", closed: true }),
      issue(5, { body: "Part of #9" }),
    ]);
    expect(progress.get(1)).toEqual({ done: 1, total: 3, remaining: [2, 3] });
  });

  it("does not count the epic as its own child, and an empty epic is 0 of 0", () => {
    const progress = epicProgress([
      issue(1, { labels: ["ask:epic"], body: "- [ ] #1" }),
      issue(6, { labels: ["ask:plan"] }),
    ]);
    expect(progress.get(1)).toEqual({ done: 0, total: 0, remaining: [] });
    expect(progress.get(6)).toEqual({ done: 0, total: 0, remaining: [] });
  });
});
