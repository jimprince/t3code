import {
  lastActivityAt,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";

import { firstLine, type Band } from "./workstreamBands.logic";
import { threadTag, type ThreadTag } from "./workstreamThreads.logic";

/** A team member's tag: a standing agent between turns is idle, never "done". */
export type TeamTag = Exclude<ThreadTag, "done"> | "idle";

export interface TeamMember {
  readonly threadId: string;
  readonly title: string;
  readonly head: boolean;
  readonly tag: TeamTag;
  /** What the agent is responsible for: its thread scope. */
  readonly responsibility: string | null;
  /** "3 workstreams · 10 tasks": what it owns, by the tasks its thread is linked to. */
  readonly owns: string | null;
  readonly latest: string | null;
  readonly at: string;
}

/** A member's tag; a standing agent that is not asking, failing or working is idle, never done. */
function teamTag(
  thread: OrchestratorThreadShell,
  workerNotes: ReadonlyMap<string, string>,
): TeamTag {
  const tag = threadTag(thread, { since: null, workerNotes });
  return tag === null || tag === "done" ? "idle" : tag;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Whether a thread sits directly under the head, by the same parent link the thread tree uses. */
function isDirectChild(thread: OrchestratorThreadShell, root: OrchestratorThreadShell): boolean {
  const parent =
    thread.supervisionParentKey === undefined
      ? thread.remoteParent
        ? `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`
        : thread.parentThreadId == null
          ? null
          : `${thread.environmentId}:${thread.parentThreadId}`
      : thread.supervisionParentKey;
  return parent === `${root.environmentId}:${root.id}`;
}

/**
 * Whether a thread is a standing agent of the project: directly under the head,
 * with a thread scope of its own, not settled and not archived.
 */
export function isTeamMember(
  thread: OrchestratorThreadShell,
  root: OrchestratorThreadShell,
): boolean {
  return (
    thread.archivedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.scope ?? "").trim().length > 0 &&
    isDirectChild(thread, root)
  );
}

/**
 * The Team strip: the project's head first, then its standing sub-agents (directly
 * under it, with a thread scope, not settled). A member owns the workstreams and
 * open tasks its thread is linked to, as the page shows them; the head owns all.
 */
export function deriveTeam(input: {
  readonly root: OrchestratorThreadShell;
  readonly descendants: ReadonlyArray<OrchestratorThreadShell>;
  readonly bands: ReadonlyArray<Band>;
  readonly workerNotes: ReadonlyMap<string, string>;
}): TeamMember[] {
  const { root, descendants, bands, workerNotes } = input;
  const members = descendants.filter((thread) => isTeamMember(thread, root));
  if (members.length === 0) return [];
  const bandRows = bands.flatMap((band) => band.rows);
  const member = (thread: OrchestratorThreadShell, head: boolean): TeamMember => {
    // What the page shows as work: the head owns every workstream and open task, a member
    // the workstreams and tasks its thread is linked to.
    const ownedBands = bands.filter(
      (band) => band.epic !== null && (head || band.epic.linkedThreadIds.includes(thread.id)),
    );
    const ownedTasks = bandRows.filter(
      (row) => head || row.issue.linkedThreadIds.includes(thread.id),
    );
    const workstreams = ownedBands.length;
    const tasks = ownedTasks.length;
    const parts = [
      workstreams > 0 ? plural(workstreams, "workstream") : null,
      tasks > 0 ? plural(tasks, "task") : null,
    ].filter((part): part is string => part !== null);
    return {
      threadId: thread.id,
      title: thread.title,
      head,
      tag: teamTag(thread, workerNotes),
      responsibility: firstLine(thread.scope, 160),
      owns: parts.length > 0 ? parts.join(" · ") : null,
      latest: firstLine(thread.source.workerSummary?.output),
      at: lastActivityAt(thread),
    };
  };
  return [member(root, true), ...members.map((thread) => member(thread, false))];
}

export const TEAM_TAG_LABEL: Record<TeamTag, string> = {
  waiting: "waiting on you",
  error: "error",
  blocked: "blocked",
  running: "running",
  idle: "idle",
};

/** The ids deriveThreadView leaves out of Other threads: the Team is not a pool of freelancers. */
export const teamIds = (
  root: OrchestratorThreadShell,
  descendants: ReadonlyArray<OrchestratorThreadShell>,
) =>
  new Set([
    root.id as string,
    ...descendants
      .filter((thread) => isTeamMember(thread, root))
      .map((thread) => thread.id as string),
  ]);
