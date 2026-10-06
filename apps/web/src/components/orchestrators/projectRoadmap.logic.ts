import type { ProjectRoadmap, ProjectRoadmapItem } from "@t3tools/contracts";

export type RoadmapTarget =
  /** The automatic next version: the first open version, or no version at all. */
  | { readonly kind: "next" }
  | { readonly kind: "version"; readonly title: string }
  /** Parked: saved for later and kept off the Dashboard. */
  | { readonly kind: "later" };

export interface RoadmapColumn {
  readonly key: string;
  readonly title: string;
  /** A real version (milestone) that can be renamed; null for the automatic ones. */
  readonly versionId: number | null;
  readonly target: RoadmapTarget;
  readonly items: ReadonlyArray<ProjectRoadmapItem>;
  /** Closed tasks of the column's version, counted as Complete in its progress line. */
  readonly completeCount: number;
}

/**
 * Next version first, filled automatically: the first open version's items plus
 * every unversioned item that is not parked. Then each later open version, and
 * Later last (parked items without a version).
 */
export function roadmapColumns(roadmap: ProjectRoadmap): RoadmapColumn[] {
  const [first, ...rest] = roadmap.versions;
  const unversioned = roadmap.items.filter((item) => item.versionId === null);
  const next: RoadmapColumn = {
    key: "next",
    title: first ? first.title : "Next version",
    versionId: first?.id ?? null,
    target: first ? { kind: "version", title: first.title } : { kind: "next" },
    completeCount: first?.closedIssues ?? 0,
    items: [
      ...(first ? roadmap.items.filter((item) => item.versionId === first.id) : []),
      ...unversioned.filter((item) => !item.parked),
    ],
  };
  return [
    next,
    ...rest.map((version) => ({
      key: String(version.id),
      title: version.title,
      versionId: version.id,
      target: { kind: "version", title: version.title } as const,
      completeCount: version.closedIssues,
      items: roadmap.items.filter((item) => item.versionId === version.id),
    })),
    {
      key: "later",
      title: "Later",
      versionId: null,
      target: { kind: "later" },
      completeCount: 0,
      items: unversioned.filter((item) => item.parked),
    },
  ];
}

/** The column an item sits in, so a move to the same place is a no-op. */
export const columnOf = (columns: ReadonlyArray<RoadmapColumn>, item: ProjectRoadmapItem) =>
  columns.find((column) => column.items.some((candidate) => candidate.number === item.number));

/** The move request for a target: a version title, the automatic next, or Later. */
export function moveInput(target: RoadmapTarget): { version: string | null; later?: true } {
  if (target.kind === "version") return { version: target.title };
  return target.kind === "later" ? { version: null, later: true } : { version: null };
}

/** The next release: the first open version, if any. */
export function nextReleaseVersion(
  roadmap: ProjectRoadmap | null,
): { id: number; title: string } | null {
  const version = roadmap?.versions[0];
  return version ? { id: version.id, title: version.title } : null;
}
