import type {
  DashboardProject,
  DashboardTask,
  DashboardWorkstream,
  ProjectRequestPlacer,
} from "@t3tools/contracts";

/**
 * The tracker Plan's order, as one pure selector the web Dashboard and mobile share. The order is
 * the stored `rank` of each issue (workstreams by their epic's rank, tasks by their own); this
 * file only sorts and sections what the snapshot already carries, and plans the writes a move
 * needs. Clients never invent a rank: they ask the server to place an item.
 */

/** How long a filed item wears the "new" mark. It expires by time; nothing is written to clear it. */
export const NEW_MARK_MS = 4 * 3_600_000;

/** The issue number of a snapshot id such as `issue:host/owner/repo#155`. */
export function issueNumber(id: string): number | null {
  const match = /#(\d+)$/.exec(id);
  return match ? Number(match[1]) : null;
}

/** Whether an item filed at `createdAt` still shows the "new" mark. */
export function isNewlyFiled(createdAt: string | undefined, now: number): boolean {
  if (createdAt === undefined) return false;
  const at = Date.parse(createdAt);
  return Number.isFinite(at) && now - at < NEW_MARK_MS;
}

/** "Brad" or the agent's name; null when nobody is recorded. */
export function placerName(placer: ProjectRequestPlacer | null | undefined): string | null {
  if (!placer) return null;
  return placer.kind === "brad" ? "Brad" : placer.name?.trim() || "an agent";
}

/** The hover text of the "new" mark: who put the item where it is, or that nobody has yet. */
export function newMarkTitle(item: {
  readonly rank?: number | null | undefined;
  readonly placedBy?: ProjectRequestPlacer | null | undefined;
}): string {
  const who = placerName(item.placedBy);
  if (who) return `New, placed by ${who}`;
  return item.rank == null ? "New, not placed yet" : "New, placer unknown";
}

export interface OrderedWorkstream {
  readonly workstream: DashboardWorkstream;
  /** Started work, and items waiting on Brad that have no place yet: shown first, never numbered. */
  readonly now: DashboardTask[];
  /** Queued work in order; an item's position is its index plus one. */
  readonly next: DashboardTask[];
  /** Recently finished, in the snapshot's order. */
  readonly done: DashboardTask[];
}

export interface OrderedPlan {
  /** True for a tracker project: only then is the order stored in the tracker and editable. */
  readonly ordered: boolean;
  /** "New, not ordered": filed items with no rank, newest first. */
  readonly fresh: DashboardTask[];
  /** Parked items, counted on their own: Later is a count here, never a list. */
  readonly later: number;
  /** Epic workstreams in rank order, then the groups that are not epics. */
  readonly workstreams: OrderedWorkstream[];
}

const compareStored = (
  a: { readonly rank: number | null; readonly number: number; readonly index: number },
  b: { readonly rank: number | null; readonly number: number; readonly index: number },
) => {
  if (a.rank === null || b.rank === null) {
    if (a.rank !== b.rank) return a.rank === null ? 1 : -1;
  } else if (a.rank !== b.rank) return a.rank - b.rank;
  return a.number - b.number || a.index - b.index;
};

function sortStored<T>(
  items: ReadonlyArray<T>,
  rankOf: (item: T) => number | null | undefined,
  idOf: (item: T) => string,
): T[] {
  return items
    .map((item, index) => ({
      item,
      index,
      rank: rankOf(item) ?? null,
      number: issueNumber(idOf(item)) ?? Number.MAX_SAFE_INTEGER,
    }))
    .sort(compareStored)
    .map((entry) => entry.item);
}

const isEpicHeader = (workstream: DashboardWorkstream) => typeof workstream.url === "string";

/**
 * The project's Plan in stored order. A briefing-plan project keeps the snapshot's order and gets
 * no New block: only the tracker stores a rank.
 */
export function orderPlan(project: DashboardProject): OrderedPlan {
  const ordered = project.planSource === "tracker";
  const workstreamIds = new Set(project.workstreams.map((workstream) => workstream.id));
  const byId = new Map(project.tasks.map((task) => [task.id, task]));
  const ownerOf = new Map<string, string>();
  for (const workstream of project.workstreams)
    for (const id of workstream.taskIds) ownerOf.set(id, workstream.id);

  const isFresh = (task: DashboardTask) =>
    ordered &&
    task.kind !== undefined &&
    task.parked !== true &&
    (task.rank ?? null) === null &&
    (task.status === "pending" || (task.status === "blocked" && task.attentionIds.length === 0));

  let later = 0;
  const fresh: DashboardTask[] = [];
  const sections = new Map<
    string,
    { now: DashboardTask[]; next: DashboardTask[]; done: DashboardTask[] }
  >();
  for (const workstream of project.workstreams)
    sections.set(workstream.id, { now: [], next: [], done: [] });

  for (const workstream of project.workstreams) {
    const section = sections.get(workstream.id)!;
    for (const id of workstream.taskIds) {
      const task = byId.get(id);
      // The epic's own task rides along only to carry a waiting decision; it is the header.
      if (!task || workstreamIds.has(task.id) || ownerOf.get(id) !== workstream.id) continue;
      if (ordered && task.parked === true && task.status !== "done") {
        later += 1;
        continue;
      }
      if (task.status === "done") section.done.push(task);
      else if (isFresh(task)) fresh.push(task);
      else if (!ordered) section.next.push(task);
      else if (
        task.status === "working" ||
        (task.kind !== undefined && (task.rank ?? null) === null)
      )
        section.now.push(task);
      else section.next.push(task);
    }
  }

  const sortTasks = (tasks: DashboardTask[]) =>
    ordered
      ? sortStored(
          tasks,
          (task) => task.rank,
          (task) => task.id,
        )
      : tasks;
  const entries: OrderedWorkstream[] = project.workstreams.map((workstream) => {
    const section = sections.get(workstream.id)!;
    return {
      workstream,
      now: sortTasks(section.now),
      next: sortTasks(section.next),
      done: section.done,
    };
  });
  const epics = entries.filter((entry) => isEpicHeader(entry.workstream));
  const rest = entries.filter((entry) => !isEpicHeader(entry.workstream));
  return {
    ordered,
    fresh: [...fresh].sort(
      (a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        (issueNumber(b.id) ?? 0) - (issueNumber(a.id) ?? 0),
    ),
    later,
    workstreams: [
      ...(ordered
        ? sortStored(
            epics,
            (entry) => entry.workstream.rank,
            (entry) => entry.workstream.id,
          )
        : epics),
      ...rest,
    ],
  };
}

/** What a move asks the server to do with one item; clients never send a rank. */
export type PlaceTarget =
  | { readonly to: "top" | "bottom" | "none" }
  | { readonly to: "before" | "after"; readonly id: string };
export interface PlaceStep {
  readonly id: string;
  readonly place: PlaceTarget;
}
export type MoveTo =
  | { readonly to: "top" }
  | { readonly to: "bottom" }
  | { readonly to: "up" }
  | { readonly to: "down" }
  | { readonly to: "before"; readonly id: string }
  | { readonly to: "after"; readonly id: string };

/**
 * The writes that carry out a move inside one ordered list. The server only places an item
 * relative to a ranked sibling, so before the first relative move every unranked item in the list
 * is given a place at the bottom, in the order shown; that keeps the list as the user sees it. A
 * move that is already where it was asked to go writes nothing. `list` may omit the mover (an
 * item arriving from another workstream).
 */
export function planMove(
  list: ReadonlyArray<{ readonly id: string; readonly rank?: number | null | undefined }>,
  moverId: string,
  move: MoveTo,
): PlaceStep[] {
  const index = list.findIndex((item) => item.id === moverId);
  const mover = index >= 0 ? list[index]! : null;
  const ranked = mover !== null && (mover.rank ?? null) !== null;
  if (move.to === "top")
    return index === 0 && ranked ? [] : [{ id: moverId, place: { to: "top" } }];
  if (move.to === "bottom")
    return index === list.length - 1 && ranked ? [] : [{ id: moverId, place: { to: "bottom" } }];
  let target: string | undefined;
  let side: "before" | "after" = "before";
  if (move.to === "up") {
    target = index > 0 ? list[index - 1]!.id : undefined;
  } else if (move.to === "down") {
    side = "after";
    target = index >= 0 ? list[index + 1]?.id : undefined;
  } else {
    side = move.to;
    target = move.id === moverId || !list.some((item) => item.id === move.id) ? undefined : move.id;
  }
  if (target === undefined) return [];
  const materialize = list
    .filter((item) => (item.rank ?? null) === null)
    .map((item): PlaceStep => ({ id: item.id, place: { to: "bottom" } }));
  return [...materialize, { id: moverId, place: { to: side, id: target } }];
}
