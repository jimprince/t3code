import { describe, expect, it } from "vite-plus/test";

import { findVersion, orderVersions, roadmapItems } from "./projectRoadmap.logic.ts";

describe("roadmap versions", () => {
  const milestones = [
    { id: 7, title: "fork.26" },
    { id: 3, title: "Next release", due_on: "2026-10-08T00:00:00Z" },
    { id: 5, title: "fork.25", due_on: "2026-10-12T00:00:00Z" },
    { id: 9, title: "  " },
  ];

  it("orders dated versions first, then undated by creation; the first is next", () => {
    expect(orderVersions(milestones).map((milestone) => milestone.title)).toEqual([
      "Next release",
      "fork.25",
      "fork.26",
    ]);
  });

  it("finds a version by title regardless of case and spacing", () => {
    expect(findVersion(milestones, " next RELEASE ")?.id).toBe(3);
    expect(findVersion(milestones, "fork.99")).toBeUndefined();
  });
});

describe("roadmap items", () => {
  const issue = (number: number, overrides: Record<string, unknown> = {}) =>
    ({
      host: "git.example",
      repository: "brad/t3code-fork",
      number,
      title: `Item ${number}`,
      url: `https://git.example/brad/t3code-fork/issues/${number}`,
      status: "pending",
      isRequest: true,
      stage: "requested",
      closedAt: null,
      milestone: null,
      labels: [],
      ...overrides,
    }) as never;

  it("puts open tracker items in their open version or Later, and drops shipped ones", () => {
    const items = roadmapItems(
      [
        issue(1),
        issue(2, { milestone: { id: 3, title: "Next release" } }),
        issue(3, { milestone: { id: 4, title: "fork.24" }, stage: "needs-test" }),
        issue(4, { status: "done", closedAt: "2026-10-05T00:00:00Z" }),
        issue(5, { repository: "brad/other" }),
        issue(6, { isRequest: false, stage: undefined }),
        issue(7, { labels: ["ask", "Parked"] }),
      ],
      { host: "git.example", repository: "brad/t3code-fork" },
      [{ id: 3, title: "Next release" }],
    );
    expect(items.map((item) => [item.number, item.versionId, item.stage, item.parked])).toEqual([
      [1, null, "requested", false],
      [2, 3, "requested", false],
      [6, null, null, false],
      [7, null, "requested", true],
    ]);
  });
});
