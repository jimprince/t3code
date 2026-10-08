import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import type { ProjectIssue } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveBands } from "./workstreamBands.logic";
import { deriveTeam, isTeamMember, teamIds } from "./workstreamTeam.logic";
import { deriveThreadView } from "./workstreamThreads.logic";

const issue = (number: number, overrides: Partial<ProjectIssue> = {}): ProjectIssue =>
  ({
    host: "git.home",
    repository: "brad/repo",
    number,
    title: `Issue ${number}`,
    url: `https://git.home/brad/repo/issues/${number}`,
    status: "pending",
    labels: [],
    isRequest: false,
    requestSource: null,
    assignees: [],
    comments: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z",
    closedAt: null,
    linkedThreadIds: [],
    ...overrides,
  }) as ProjectIssue;

const thread = (
  id: string,
  overrides: {
    scope?: string | null;
    working?: boolean;
    settled?: boolean;
    archived?: boolean;
    parent?: string | null;
    completedAt?: string;
  } = {},
) =>
  ({
    id,
    title: `Thread ${id}`,
    scope: overrides.scope ?? null,
    environmentId: "env",
    parentThreadId: overrides.parent === undefined ? "root" : overrides.parent,
    archivedAt: overrides.archived ? "2026-10-05T00:00:00.000Z" : null,
    settledOverride: overrides.settled ? "settled" : null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-03T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    runtime: { status: overrides.working ? "running" : "idle" },
    pendingBackgroundTasks: [],
    codexNativeGoal: null,
    todoProgress: null,
    latestRun: overrides.completedAt ? { completedAt: overrides.completedAt } : null,
    source: { workerSummary: undefined },
  }) as unknown as OrchestratorThreadShell;

const epic = issue(10, { epic: { done: 0, total: 1, remaining: [11] } });

function team(descendants: OrchestratorThreadShell[], issues: ProjectIssue[]) {
  const root = thread("root", { scope: "Maintains the fork", parent: null });
  const bands = deriveBands({
    issues,
    statuses: new Map(),
    threadsById: new Map([root, ...descendants].map((t) => [t.id as string, t])),
    rootThreadId: "root",
  });
  return {
    root,
    bands,
    members: deriveTeam({ root, descendants, bands, workerNotes: new Map() }),
  };
}

describe("isTeamMember", () => {
  const root = thread("root", { parent: null });

  it("takes a scoped, unsettled, unarchived thread directly under the head only", () => {
    expect(isTeamMember(thread("a", { scope: "Dashboard" }), root)).toBe(true);
    expect(isTeamMember(thread("a"), root)).toBe(false);
    expect(isTeamMember(thread("a", { scope: "  " }), root)).toBe(false);
    expect(isTeamMember(thread("a", { scope: "Dashboard", settled: true }), root)).toBe(false);
    expect(isTeamMember(thread("a", { scope: "Dashboard", archived: true }), root)).toBe(false);
    expect(isTeamMember(thread("a", { scope: "Dashboard", parent: "other" }), root)).toBe(false);
  });
});

describe("deriveTeam", () => {
  it("is empty without a standing agent, so a project of one-task workers shows no strip", () => {
    expect(team([thread("w1"), thread("w2", { working: true })], [epic]).members).toEqual([]);
  });

  it("lists the head first, then each standing agent with its responsibility and an idle tag between turns", () => {
    const { members } = team(
      [thread("dash", { scope: "Project page and dashboard" }), thread("w1")],
      [epic, issue(11, { partOf: 10 })],
    );
    expect(members.map((m) => [m.threadId, m.head, m.tag, m.responsibility])).toEqual([
      ["root", true, "idle", "Maintains the fork"],
      ["dash", false, "idle", "Project page and dashboard"],
    ]);
  });

  it("tags a working standing agent running and never reports done", () => {
    const { members } = team([thread("dash", { scope: "Dashboard", working: true })], []);
    expect(members[1]!.tag).toBe("running");
  });

  it("counts what each owns as the page shows it: the head all, a member its linked work", () => {
    const { members } = team(
      [thread("dash", { scope: "Dashboard" })],
      [
        { ...epic, linkedThreadIds: [] } as ProjectIssue,
        issue(11, { partOf: 10 }),
        issue(20, { linkedThreadIds: ["dash"] as never }),
        issue(21, { linkedThreadIds: ["dash"] as never }),
        issue(22, {
          linkedThreadIds: ["dash"] as never,
          status: "done",
          closedAt: "2026-10-04T00:00:00.000Z",
        }),
      ],
    );
    expect(members[0]!.owns).toBe("1 workstream · 3 tasks");
    expect(members[1]!.owns).toBe("2 tasks");
  });

  it("gives a member the workstream its thread is linked to", () => {
    const { members } = team(
      [thread("dash", { scope: "Dashboard" })],
      [
        { ...epic, linkedThreadIds: ["dash"] } as unknown as ProjectIssue,
        issue(11, { partOf: 10 }),
      ],
    );
    expect(members[1]!.owns).toBe("1 workstream");
  });
});

describe("Team in the thread view", () => {
  it("keeps a standing agent out of the thread rows of the workstream it works on", () => {
    const dash = thread("dash", { scope: "Dashboard", working: true });
    const stuck = issue(30, { blockedBy: [31], linkedThreadIds: ["dash"] as never });
    const root = thread("root");
    const issues = [
      epic,
      issue(11, { partOf: 10, linkedThreadIds: ["dash"] as never }),
      stuck,
      issue(31),
    ];
    const bands = deriveBands({
      issues,
      statuses: new Map(),
      threadsById: new Map([root, dash].map((t) => [t.id as string, t])),
      rootThreadId: "root",
    });
    const view = deriveThreadView({
      bands,
      summary: { root, descendants: [dash] },
      workerNotes: new Map(),
      since: null,
      exclude: teamIds(root, [dash]),
    });
    expect(view.byBand.get("brad/repo#10")).toEqual([]);
    // Its blocked task still gets its own row: the agent's strip entry does not explain it.
    expect(view.other.map((row) => [row.key, row.tag])).toEqual([["task:brad/repo#30", "blocked"]]);
  });

  it("keeps standing agents out of Other threads", () => {
    const dash = thread("dash", { scope: "Dashboard", working: true });
    const freelancer = thread("w1", { working: true });
    const root = thread("root");
    const view = deriveThreadView({
      bands: [],
      summary: { root, descendants: [dash, freelancer] },
      workerNotes: new Map(),
      since: null,
      exclude: teamIds(root, [dash, freelancer]),
    });
    expect(view.other.map((row) => row.threadId)).toEqual(["w1"]);
  });
});
