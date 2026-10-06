import { describe, expect, it } from "vite-plus/test";

import { moveInput, nextReleaseVersion, roadmapColumns } from "./projectRoadmap.logic";

const item = (number: number, versionId: number | null, parked = false) => ({
  number,
  title: `Item ${number}`,
  url: `https://git.example/brad/t3code-fork/issues/${number}`,
  isRequest: true,
  stage: "requested" as const,
  versionId,
  parked,
});

const columnsOf = (roadmap: Parameters<typeof roadmapColumns>[0]) =>
  roadmapColumns(roadmap).map((column) => [column.title, column.items.map((i) => i.number)]);

describe("roadmap columns", () => {
  const tracker = { host: "git.example", repository: "brad/t3code-fork" };

  it("fills the next version with its items and all unversioned work, Later last", () => {
    const roadmap = {
      tracker,
      versions: [
        { id: 3, title: "fork.25", dueOn: null, openIssues: 1 },
        { id: 5, title: "fork.26", dueOn: null, openIssues: 0 },
      ],
      items: [item(1, null), item(2, 3), item(4, null, true), item(6, 5)],
    };
    expect(columnsOf(roadmap)).toEqual([
      ["fork.25", [2, 1]],
      ["fork.26", [6]],
      ["Later", [4]],
    ]);
    expect(nextReleaseVersion(roadmap)).toEqual({ id: 3, title: "fork.25" });
    expect(nextReleaseVersion(null)).toBeNull();
  });

  it("has a next version even before any version exists", () => {
    const columns = roadmapColumns({ tracker, versions: [], items: [item(1, null)] });
    expect(columns.map((column) => [column.title, column.target])).toEqual([
      ["Next version", { kind: "next" }],
      ["Later", { kind: "later" }],
    ]);
    expect(columns[0]!.items.map((i) => i.number)).toEqual([1]);
  });

  it("asks the server for a version, the automatic next, or Later", () => {
    expect(moveInput({ kind: "version", title: "fork.26" })).toEqual({ version: "fork.26" });
    expect(moveInput({ kind: "next" })).toEqual({ version: null });
    expect(moveInput({ kind: "later" })).toEqual({ version: null, later: true });
  });
});
