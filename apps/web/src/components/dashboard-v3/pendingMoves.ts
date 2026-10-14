import { orderPlan } from "@t3tools/client-runtime/dashboard/order";
import type { DashboardProject } from "@t3tools/contracts";

import type { ScopedProject } from "./dashboard.logic";

/**
 * A move the page shows before the snapshot has it. The order RPC returns before the refreshed
 * snapshot lands, so a second move made in that gap would read the old list and land wrong.
 * The overlay renumbers the list at once: every row in `order` is given the rank of its index,
 * which is also what the server does when it first ranks an unranked list.
 */
export interface PendingMove {
  readonly projectKey: string;
  readonly list:
    | { readonly kind: "tasks"; readonly workstreamId: string; readonly partOf: number | null }
    | { readonly kind: "workstreams" };
  /** The destination's queued ids (or the epic ids when workstreams move) after the move. */
  readonly order: ReadonlyArray<string>;
  readonly moved: string;
}

const listKey = (move: PendingMove) =>
  move.list.kind === "tasks" ? move.list.workstreamId : "workstreams";

function applyToProject(project: DashboardProject, move: PendingMove): DashboardProject {
  const ranks = new Map(move.order.map((id, index) => [id, index + 1] as const));
  if (move.list.kind === "workstreams") {
    return {
      ...project,
      workstreams: project.workstreams.map((workstream) =>
        ranks.has(workstream.id) ? { ...workstream, rank: ranks.get(workstream.id)! } : workstream,
      ),
    };
  }
  const { workstreamId, partOf } = move.list;
  return {
    ...project,
    tasks: project.tasks.map((task) =>
      ranks.has(task.id)
        ? {
            ...task,
            rank: ranks.get(task.id)!,
            ...(task.id === move.moved ? { partOf, workstreamId } : {}),
          }
        : task,
    ),
    workstreams: project.workstreams.map((workstream) => {
      const without = workstream.taskIds.filter((id) => id !== move.moved);
      if (workstream.id !== workstreamId) return { ...workstream, taskIds: without };
      return { ...workstream, taskIds: [...without, move.moved] };
    }),
  };
}

/** The projects with every pending move applied, in the order they were made. */
export function applyPendingMoves(
  projects: ReadonlyArray<ScopedProject>,
  moves: ReadonlyArray<PendingMove>,
): ReadonlyArray<ScopedProject> {
  if (moves.length === 0) return projects;
  return projects.map((scoped) => {
    const mine = moves.filter((move) => move.projectKey === scoped.key);
    return mine.length === 0
      ? scoped
      : { ...scoped, project: mine.reduce(applyToProject, scoped.project) };
  });
}

/**
 * Whether a snapshot has caught up with a project's pending moves: for each list the page
 * reordered, the snapshot shows the order of the last move made in it.
 */
export function snapshotHasCaughtUp(
  project: DashboardProject,
  moves: ReadonlyArray<PendingMove>,
): boolean {
  const plan = orderPlan(project);
  const last = new Map(moves.map((move) => [listKey(move), move] as const));
  return [...last.values()].every((move) => {
    const { list } = move;
    const shown =
      list.kind === "workstreams"
        ? plan.workstreams
            .filter((entry) => typeof entry.workstream.url === "string")
            .map((entry) => entry.workstream.id)
        : plan.workstreams
            .find((entry) => entry.workstream.id === list.workstreamId)
            ?.next.map((task) => task.id);
    // A list the snapshot no longer has has nothing left to wait for.
    return shown === undefined || shown.join("\n") === move.order.join("\n");
  });
}
