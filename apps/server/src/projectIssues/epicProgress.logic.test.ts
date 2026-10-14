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
    expect(parsePartOf("> An introduction\nPart of #7")).toBeNull();
    expect(parsePartOf("```md\nExample\n```\nPart of #7")).toBeNull();
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

describe("tracker workstream membership (#297)", () => {
  it("infers #271 and #74 from canonical children and counts complete personal steps", () => {
    const result = epicProgress([
      issue(271, { labels: ["ask:task"] }),
      issue(308, { body: "Part of #271\n\n- [x] Ship" }),
      issue(309, { body: "Part of #271" }),
      issue(74),
      issue(189, { body: "Part of #74" }),
    ]);
    expect(result.get(271)).toMatchObject({ done: 1, total: 2, remaining: [309] });
    expect(result.get(74)).toMatchObject({ done: 0, total: 1, remaining: [189] });
  });
  it("uses canonical Part of over conflicting parent checklists", () => {
    const result = epicProgress([
      issue(1, { labels: ["ask:epic"], body: "- [ ] #3\n- [x] #3" }),
      issue(2, { labels: ["ask:epic"] }),
      issue(3, { body: "Part of #2" }),
    ]);
    expect(result.get(1)).toMatchObject({ total: 0 });
    expect(result.get(2)).toMatchObject({ total: 1 });
  });
  it("ignores fenced refs and recognizes publication markers before Part of", () => {
    expect(parseEpicChecklist("```md\n- [x] #2\n```\n> - [x] #3\n- [ ] #4")).toEqual([
      { number: 4, checked: false },
    ]);
    expect(parsePartOf("<!-- t3-plan: abc -->\nPart of #155\n\nTask")).toBe(155);
  });
});

it("reports cycles and retains missing unticked children as unknown work", async () => {
  const { trackerMembership } = await import("./epicProgress.logic.ts");
  const cycle = trackerMembership([
    issue(1, { body: "Part of #2" }),
    issue(2, { body: "Part of #1" }),
  ]);
  expect(cycle.parents.size).toBe(0);
  expect(cycle.warnings.get(1)).toContain("cyclic-membership");
  const unknown = trackerMembership([
    issue(1, { labels: ["ask:epic"], body: "- [ ] #99\n- [x] #98" }),
  ]);
  expect(unknown.children.get(1)).toEqual([
    { number: 99, done: false, unknown: true },
    { number: 98, done: true, unknown: false },
  ]);
});

it("reports a malformed first-line parent rather than inventing a numeric reference", async () => {
  const { trackerMembership } = await import("./epicProgress.logic.ts");
  const result = trackerMembership([issue(1, { body: "Part of #0" })]);
  expect(result.parents.size).toBe(0);
  expect(result.warnings.get(1)).toEqual(["malformed-parent"]);
});

it("accumulates distinct membership warnings (#297 N4)", async () => {
  const { trackerMembership } = await import("./epicProgress.logic.ts");
  const result = trackerMembership([
    issue(1, { body: "Part of #99\n- [ ] #1" }),
    issue(2, { body: "- [ ] #1" }),
  ]);
  expect(result.warnings.get(1)).toEqual(
    expect.arrayContaining([
      "self-reference",
      "missing-or-closed-parent",
      "conflicting-checklist-parents",
    ]),
  );
});

it("bounds membership regex paths for pathological bodies (#297 B2)", () => {
  for (const size of [256 * 1024, 1024 * 1024])
    for (const unit of [" ", "- [ ] ", "[x]", "x", "a_a_a_", "http://", "\n"]) {
      const text = unit.repeat(Math.ceil(size / unit.length));
      const start = performance.now();
      parsePartOf(text);
      parsePartOf("<!-- t3-plan:" + text + " -->\nPart of #12");
      parseEpicChecklist("- [ ] #" + text);
      expect(performance.now() - start).toBeLessThan(100);
    }
});

it("drops a truncated partial checklist reference instead of inventing #12 (#297 R2-N7)", () => {
  const prefix = "padding\n".repeat(8180);
  const padding = " ".repeat(65536 - prefix.length - "- [ ] #12".length);
  expect(parseEpicChecklist(prefix + padding + "- [ ] #12345 title")).toEqual([]);
  expect(parsePartOf(" ".repeat(65536 - "Part of #12".length) + "Part of #12345")).toBeNull();
});
