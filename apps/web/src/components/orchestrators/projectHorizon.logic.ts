import type { ProjectEpicProgress, ProjectRoadmap, ProjectRoadmapItem } from "@t3tools/contracts";

import { countStatuses, type StatusCounts, type TaskStatus } from "./projectRequests.logic";
import { roadmapColumns } from "./projectRoadmap.logic";

export type EpicPhase = "Planning" | "Building" | "Review" | "Complete";

/**
 * Where an epic stands: Complete when no child is left, Review when every child
 * left waits for review, Building once any child is done or started, otherwise
 * Planning. `statusOf` reads a child's task status by issue number.
 */
export function epicPhase(
  epic: ProjectEpicProgress,
  statusOf: (number: number) => TaskStatus,
): EpicPhase {
  if (epic.total > 0 && epic.remaining.length === 0) return "Complete";
  const remaining = epic.remaining.map(statusOf);
  if (remaining.length > 0 && remaining.every((status) => status === "for-review")) {
    return "Review";
  }
  return epic.done > 0 || remaining.some((status) => status !== "pending")
    ? "Building"
    : "Planning";
}

/** "1 of 4 · Building"; an epic with no children yet is just its phase. */
export const formatEpicProgress = (epic: ProjectEpicProgress, phase: EpicPhase) =>
  epic.total > 0 ? `${epic.done} of ${epic.total} · ${phase}` : phase;

/** A release's outcome: the first line of its milestone description, without markdown markers. */
export function releaseOutcome(description: string | null | undefined): string | null {
  const line = (description ?? "")
    .split("\n")
    .map((text) => text.replace(/^[\s#>*-]+/, "").trim())
    .find((text) => text.length > 0);
  return line ?? null;
}

export interface Horizon {
  /** The next release's version title, or null while no version exists. */
  readonly version: string | null;
  readonly outcome: string | null;
  /** "N of M done" for the next release. */
  readonly counts: StatusCounts;
  /** The task to deliver next: an Active one first, then one waiting for review. */
  readonly next: { readonly item: ProjectRoadmapItem; readonly status: TaskStatus } | null;
  readonly epics: ReadonlyArray<{ readonly item: ProjectRoadmapItem; readonly phase: EpicPhase }>;
  /** Everything beyond the next release, collapsed to one count. */
  readonly later: number;
}

/** Where we're going: the next release first, everything after it as one count. */
export function deriveHorizon(
  roadmap: ProjectRoadmap,
  statusOf: (number: number) => TaskStatus,
): Horizon {
  const [next, ...beyond] = roadmapColumns(roadmap);
  const version = roadmap.versions[0] ?? null;
  const items = next?.items ?? [];
  const tasks = items.filter((item) => item.epic === undefined);
  const nextTask =
    (["active", "for-review"] as const).flatMap((status) =>
      tasks.filter((item) => statusOf(item.number) === status).map((item) => ({ item, status })),
    )[0] ?? null;
  return {
    version: version?.title ?? null,
    outcome: releaseOutcome(version?.description),
    counts: countStatuses(
      items.map((item) => statusOf(item.number)),
      next?.completeCount ?? 0,
    ),
    next: nextTask,
    epics: items.flatMap((item) =>
      item.epic ? [{ item, phase: epicPhase(item.epic, statusOf) }] : [],
    ),
    later: beyond.reduce((total, column) => total + column.items.length, 0),
  };
}
