/**
 * Tracker order contract: /home/brad/maintenance-work/t3-product/tracker-plan/CONTRACT.md
 * Draft v0 sha256 eb397fd3b9438478e2e6ddc3bcc863eb225d376ca9547478817ae615232521fe.
 * Last-line trailer; in-progress first, rank then issue number, unranked last.
 * Rank changes never represent progress. #297 imports parseRankTrailer for Plan mapping.
 */
import type {
  ProjectIssue,
  ProjectRequestPlacer,
  ProjectRequestPlace,
  ProjectRequestQueueResult,
} from "@t3tools/contracts";

const placerTrailer = /(?:^|\r?\n)<!-- t3:placed-by ([^\r\n]+) -->$/;
const trailer = /(?:^|\r?\n)<!-- t3:rank (-?\d+(?:\.\d+)?) -->(?:\r?\n)?$/;
export function parseRankTrailer(body: string | null | undefined): number | null {
  const value = trailer.exec(body ?? "")?.[1];
  const rank = value === undefined ? null : Number(value);
  return rank !== null && Number.isSafeInteger(rank) ? rank : null;
}
/** Attribution is a sibling line before rank, so the #297 last-line format stays valid. */
export function parsePlacedByTrailer(body: string | null | undefined): ProjectRequestPlacer | null {
  const text = body ?? "";
  const rank = trailer.exec(text);
  if (!rank) return null;
  const encoded = placerTrailer.exec(text.slice(0, rank.index))?.[1];
  if (!encoded) return null;
  try {
    const actor = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>;
    if (actor.kind === "brad") return { kind: "brad" };
    if (
      actor.kind === "agent" &&
      typeof actor.threadId === "string" &&
      (actor.name === undefined || typeof actor.name === "string")
    )
      return actor as ProjectRequestPlacer;
  } catch {
    /* A malformed optional attribution never invalidates rank. */
  }
  return null;
}
/** Changes only the last-line trailer, preserving every other byte of Brad's words. */
export function replaceRankTrailer(
  body: string,
  rank: number | null,
  actor?: ProjectRequestPlacer,
): string {
  const match = trailer.exec(body);
  let base = match ? body.slice(0, match.index) : body;
  if (rank === null || actor) base = base.replace(placerTrailer, "");
  if (actor && rank !== null)
    base += `${!base ? "" : "\n"}<!-- t3:placed-by ${encodeURIComponent(JSON.stringify(actor))} -->`;
  return rank === null ? base : `${base}${!base ? "" : "\n"}<!-- t3:rank ${rank} -->`;
}
export function replacePartOf(body: string, partOf: number | null): string {
  const base = body.replace(/^Part of #\d+(?:(?:\r?\n){1,2}|$)/i, "");
  return partOf === null ? base : `Part of #${partOf}\n\n${base}`;
}
export const isEpic = (issue: ProjectIssue) =>
  issue.labels.includes("ask:epic") ||
  (issue.labels.includes("ask:plan") &&
    !issue.labels.includes("ask:task") &&
    !issue.labels.includes("ask:question")) ||
  issue.epic !== undefined;
/** Recognize declared children without inventing progress for an untyped workstream. */
export function workstreamNumbers(issues: readonly ProjectIssue[]) {
  const numbers = new Set(issues.filter(isEpic).map((i) => i.number));
  for (const issue of issues)
    if (issue.partOf !== undefined && issue.partOf !== issue.number) numbers.add(issue.partOf);
  return numbers;
}
export function orderRecords(issues: readonly ProjectIssue[]) {
  const workstreams = workstreamNumbers(issues);
  return issues.filter((i) => i.isRequest || i.partOf !== undefined || workstreams.has(i.number));
}
export function compareRank(
  a: Pick<ProjectIssue, "number" | "rank">,
  b: Pick<ProjectIssue, "number" | "rank">,
) {
  if (a.rank == null || b.rank == null)
    return a.rank == null ? (b.rank == null ? a.number - b.number : 1) : -1;
  return a.rank - b.rank || a.number - b.number;
}
export function isInProgress(
  issue: Pick<ProjectIssue, "stage"> & Partial<Pick<ProjectIssue, "status">>,
) {
  return issue.stage === undefined ? issue.status === "in-progress" : issue.stage === "in-progress";
}
export function compareOrder(
  a: Pick<ProjectIssue, "number" | "rank" | "stage"> & Partial<Pick<ProjectIssue, "status">>,
  b: Pick<ProjectIssue, "number" | "rank" | "stage"> & Partial<Pick<ProjectIssue, "status">>,
) {
  return Number(isInProgress(b)) - Number(isInProgress(a)) || compareRank(a, b);
}
export function planPlacement(
  items: readonly ProjectIssue[],
  moving: ProjectIssue,
  place: ProjectRequestPlace,
  referenceNumber?: number,
  epic = isEpic(moving),
) {
  const siblings = items
    .filter(
      (i) =>
        i.number !== moving.number &&
        i.closedAt === null &&
        (epic || !isInProgress(i)) &&
        !i.labels.includes("parked") &&
        i.rank != null,
    )
    .toSorted(epic ? compareRank : compareOrder);
  if (place.to === "none")
    return { writes: [{ number: moving.number, rank: null }], rank: null, position: null };
  let index = place.to === "top" ? 0 : siblings.length;
  if (place.to === "before" || place.to === "after") {
    const at = siblings.findIndex((i) => i.number === referenceNumber);
    if (at === -1) throw new Error("The placement reference must be an ordered, queued sibling.");
    index = at + Number(place.to === "after");
  }
  const before = siblings[index - 1]?.rank ?? null;
  const after = siblings[index]?.rank ?? null;
  const rank =
    before === null
      ? after === null
        ? 1024
        : after - 1024
      : after === null
        ? before + 1024
        : Math.floor(before + (after - before) / 2);
  if (
    Number.isSafeInteger(rank) &&
    (before === null || rank > before) &&
    (after === null || rank < after)
  ) {
    return { writes: [{ number: moving.number, rank }], rank, position: index + 1 };
  }
  const ordered = [...siblings];
  ordered.splice(index, 0, moving);
  return {
    writes: ordered.map((i, n) => ({ number: i.number, rank: (n + 1) * 1024 })),
    rank: (index + 1) * 1024,
    position: index + 1,
  };
}
export function requestQueue(
  issues: readonly ProjectIssue[],
  epic?: number,
  all = false,
): ProjectRequestQueueResult {
  const open = orderRecords(issues).filter(
    (i) => i.closedAt === null && (all || !i.labels.includes("parked")),
  );
  const workstreamIds = workstreamNumbers(issues);
  const epics = open.filter((i) => workstreamIds.has(i.number)).toSorted(compareRank);
  const tasks = open.filter(
    (i) => !workstreamIds.has(i.number) && (epic === undefined || i.partOf === epic),
  );
  const item = (issue: ProjectIssue, position: number | null) => ({
    ...issue,
    position,
    kind: workstreamIds.has(issue.number)
      ? ("epic" as const)
      : issue.labels.includes("ask:question")
        ? ("question" as const)
        : ("task" as const),
    bug: issue.labels.includes("bug"),
  });
  const workstreams = [...epics, null]
    .filter((ws) => epic === undefined || ws?.number === epic)
    .map((ws) => {
      const siblings = tasks
        .filter((i) =>
          ws === null
            ? i.partOf === undefined || !epics.some((e) => e.number === i.partOf)
            : i.partOf === ws.number,
        )
        .toSorted(compareOrder);
      return {
        ws,
        now: siblings.filter(isInProgress).map((i) => item(i, null)),
        next: siblings
          .filter((i) => !isInProgress(i) && i.rank != null)
          .map((i, n) => item(i, n + 1)),
      };
    });
  return {
    workstreams,
    new: open
      .filter((i) => i.isRequest && i.rank == null && (epic === undefined || i.partOf === epic))
      .toSorted((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number)
      .map((i) => item(i, null)),
  };
}
export function pickNext(queue: ProjectRequestQueueResult) {
  return (
    queue.workstreams
      .flatMap((ws) => ws.next)
      .find(
        (i) =>
          i.kind === "task" &&
          (i.stage === undefined || i.stage === "requested") &&
          (i.status === "pending" || i.status === "backlog") &&
          !i.labels.includes("parked") &&
          !i.labels.includes("needs-brad") &&
          i.decision === undefined &&
          !i.blockedBy?.length,
      ) ?? null
  );
}

/** Flat CLI listings retain the queue's workstream order, followed by New and closed history. */
export function orderedRequestList(issues: readonly ProjectIssue[]) {
  const records = issues;
  const repositories = new Map<string, ProjectIssue[]>();
  for (const issue of records) {
    const key = `${issue.host}/${issue.repository}`;
    repositories.set(key, [...(repositories.get(key) ?? []), issue]);
  }
  return [...repositories.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .flatMap(([, original]) => {
      const rows = orderRecords(original);
      const queue = requestQueue(rows, undefined, true);
      const ordered: ProjectIssue[] = [];
      let epicPosition = 0;
      for (const group of queue.workstreams) {
        if (group.ws)
          ordered.push({ ...group.ws, position: group.ws.rank == null ? null : ++epicPosition });
        ordered.push(...group.now, ...group.next);
      }
      const seen = new Set(ordered.map((i) => i.number));
      const fresh = queue.new.filter((i) => !seen.has(i.number));
      ordered.push(...fresh);
      for (const issue of fresh) seen.add(issue.number);
      ordered.push(
        ...rows
          .filter((i) => i.closedAt === null && !seen.has(i.number))
          .map((i) => ({ ...i, position: null })),
      );
      ordered.push(
        ...rows.filter((i) => i.closedAt !== null).map((i) => ({ ...i, position: null })),
      );
      return ordered;
    });
}
