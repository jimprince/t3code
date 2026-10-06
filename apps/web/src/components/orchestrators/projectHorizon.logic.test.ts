import type { ProjectRoadmap, ProjectRoadmapItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveHorizon,
  epicPhase,
  formatEpicProgress,
  releaseOutcome,
} from "./projectHorizon.logic";
import type { TaskStatus } from "./projectRequests.logic";

const epic = (done: number, total: number, remaining: number[]) => ({ done, total, remaining });
const statuses = (map: Record<number, TaskStatus>) => (number: number) => map[number] ?? "pending";

describe("epicPhase", () => {
  it("is Planning while no child has started", () => {
    expect(epicPhase(epic(0, 3, [1, 2, 3]), statuses({}))).toBe("Planning");
    expect(epicPhase(epic(0, 0, []), statuses({}))).toBe("Planning");
  });

  it("is Building once a child is active, for review beside pending ones, or done", () => {
    expect(epicPhase(epic(0, 2, [1, 2]), statuses({ 1: "active" }))).toBe("Building");
    expect(epicPhase(epic(0, 2, [1, 2]), statuses({ 1: "for-review" }))).toBe("Building");
    expect(epicPhase(epic(1, 3, [2, 3]), statuses({}))).toBe("Building");
  });

  it("is Review when every child left waits for review", () => {
    expect(epicPhase(epic(2, 4, [3, 4]), statuses({ 3: "for-review", 4: "for-review" }))).toBe(
      "Review",
    );
  });

  it("is Complete when no child is left", () => {
    expect(epicPhase(epic(4, 4, []), statuses({}))).toBe("Complete");
  });
});

describe("formatEpicProgress", () => {
  it("reads N of M and the phase, or only the phase for an empty epic", () => {
    expect(formatEpicProgress(epic(1, 4, [2, 3, 4]), "Building")).toBe("1 of 4 · Building");
    expect(formatEpicProgress(epic(0, 0, []), "Planning")).toBe("Planning");
  });
});

describe("releaseOutcome", () => {
  it("takes the first line of the milestone description", () => {
    expect(releaseOutcome("\n## Ship the board redesign\nMore detail")).toBe(
      "Ship the board redesign",
    );
    expect(releaseOutcome("  ")).toBeNull();
    expect(releaseOutcome(null)).toBeNull();
  });
});

describe("deriveHorizon", () => {
  const item = (number: number, overrides: Partial<ProjectRoadmapItem> = {}): ProjectRoadmapItem =>
    ({
      number,
      title: `Item ${number}`,
      url: `https://git.example/issues/${number}`,
      isRequest: true,
      stage: null,
      versionId: null,
      parked: false,
      ...overrides,
    }) as ProjectRoadmapItem;
  const roadmap = (items: ProjectRoadmapItem[]): ProjectRoadmap => ({
    tracker: { host: "git.example", repository: "brad/t3code-fork" },
    versions: [
      {
        id: 1,
        title: "fork.28",
        dueOn: null,
        openIssues: 4,
        closedIssues: 2,
        description: "Ship the board\nmore",
      },
      { id: 2, title: "fork.29", dueOn: null, openIssues: 1, closedIssues: 0, description: null },
    ],
    items,
  });

  it("counts the next release, picks the next deliverable and lists its epics", () => {
    const horizon = deriveHorizon(
      roadmap([
        item(1, { versionId: 1 }),
        item(2, { versionId: 1 }),
        item(3, { versionId: 1, epic: epic(1, 3, [4, 5]) }),
        item(4, { versionId: 2 }),
        item(5, { parked: true }),
        item(6),
      ]),
      statuses({ 2: "active", 6: "for-review" }),
    );
    expect(horizon.version).toBe("fork.28");
    expect(horizon.outcome).toBe("Ship the board");
    expect(horizon.counts).toMatchObject({ complete: 2, total: 6, active: 1, forReview: 1 });
    expect(horizon.next).toMatchObject({ status: "active", item: { number: 2 } });
    expect(horizon.epics.map((entry) => [entry.item.number, entry.phase])).toEqual([
      [3, "Building"],
    ]);
    expect(horizon.later).toBe(2);
  });

  it("has no next deliverable when nothing is active or waiting for review", () => {
    const horizon = deriveHorizon(roadmap([item(1, { versionId: 1 })]), statuses({}));
    expect(horizon.next).toBeNull();
    expect(horizon.later).toBe(0);
  });
});
