import { describe, expect, it } from "vite-plus/test";

import { nextReleaseVersion, roadmapColumns } from "./projectRoadmap.logic";

const item = (number: number, versionId: number | null) => ({
  number,
  title: `Item ${number}`,
  url: `https://git.example/brad/t3code-fork/issues/${number}`,
  isRequest: true,
  stage: "requested" as const,
  versionId,
});

describe("roadmap columns", () => {
  it("puts unversioned items in Later, then one column per version in order", () => {
    const roadmap = {
      tracker: { host: "git.example", repository: "brad/t3code-fork" },
      versions: [
        { id: 3, title: "Next release", dueOn: null, openIssues: 1 },
        { id: 5, title: "fork.26", dueOn: null, openIssues: 0 },
      ],
      items: [item(1, null), item(2, 3), item(4, null)],
    };
    expect(
      roadmapColumns(roadmap).map((column) => [column.title, column.items.map((i) => i.number)]),
    ).toEqual([
      ["Later", [1, 4]],
      ["Next release", [2]],
      ["fork.26", []],
    ]);
    expect(nextReleaseVersion(roadmap)).toEqual({ id: 3, title: "Next release" });
    expect(nextReleaseVersion(null)).toBeNull();
  });
});
