import type { ProjectRoadmap, ProjectRoadmapItem } from "@t3tools/contracts";

export interface RoadmapColumn {
  /** Null is Later: no version yet. */
  readonly versionId: number | null;
  readonly title: string;
  readonly items: ReadonlyArray<ProjectRoadmapItem>;
}

/** Later first, then each open version in roadmap order. */
export function roadmapColumns(roadmap: ProjectRoadmap): RoadmapColumn[] {
  const byVersion = (versionId: number | null) =>
    roadmap.items.filter((item) => item.versionId === versionId);
  return [
    { versionId: null, title: "Later", items: byVersion(null) },
    ...roadmap.versions.map((version) => ({
      versionId: version.id,
      title: version.title,
      items: byVersion(version.id),
    })),
  ];
}

/** The next release: the first open version, if any. */
export function nextReleaseVersion(
  roadmap: ProjectRoadmap | null,
): { id: number; title: string } | null {
  const version = roadmap?.versions[0];
  return version ? { id: version.id, title: version.title } : null;
}
