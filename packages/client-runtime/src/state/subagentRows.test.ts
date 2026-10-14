import {
  EnvironmentId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  buildOrchestratorSummaries,
  threadsVisibleInThreadsMode,
  type OrchestratorThreadShell,
} from "./orchestrators.ts";
import {
  owningProjectRoot,
  projectSubagentRows,
  settledGroupSummary,
  splitSettledSubagents,
  subagentCountLabel,
} from "./projectSubprojects.ts";
import { partitionThreadPurposes, threadPurposes } from "./threadPurpose.ts";

const env = EnvironmentId.make("env");
const at = (iso: string) => DateTime.makeUnsafe(iso);

interface Options {
  readonly parent?: string;
  /** How the thread came to be, with the lineage and creation fields the server stores for it. */
  readonly kind?: "native" | "delegate" | "worker" | "fork" | "root";
  readonly title?: string;
  readonly settled?: boolean;
  /** A real run in flight, as a delegate_task child has. */
  readonly running?: boolean;
  readonly approval?: boolean;
  readonly pending?: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly purpose?: "project" | "harness";
  readonly userCreated?: boolean;
  /** The creator's own actor and source, for a thread the server opened for the user. */
  readonly createdBy?: "user" | "agent" | "system";
  readonly creationSource?: "web" | "server" | "mcp";
  readonly activity?: string;
}

/** Shells go through presentThreadShell, so titles and runtime are what the client really sees. */
function shell(id: string, options: Options = {}): OrchestratorThreadShell {
  const kind = options.kind ?? "root";
  const parent = options.parent === undefined ? null : ThreadId.make(options.parent);
  const subagent = kind === "native" || kind === "delegate";
  const activity = at(options.activity ?? "2026-10-13T10:00:00.000Z");
  const v2: OrchestrationV2ThreadShell = {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    title: options.title ?? id,
    createdBy: options.createdBy ?? (options.userCreated ? "user" : "agent"),
    creationSource:
      options.creationSource ??
      (options.userCreated ? "web" : kind === "native" ? "provider" : "mcp"),
    createdAt: activity,
    updatedAt: activity,
    lineage: {
      rootThreadId: parent ?? ThreadId.make(id),
      parentThreadId: subagent || kind === "fork" ? parent : null,
      relationshipToParent: subagent ? "subagent" : kind === "fork" ? "fork" : null,
    },
    // A native child is runless: the provider drives its turn, so no run is ever recorded.
    activeProviderThreadId: kind === "native" ? ProviderThreadId.make(`pt-${id}`) : null,
    ...(options.running
      ? {
          latestRunId: RunId.make(`run-${id}`),
          latestRunStartedAt: activity,
          latestRunRequestedAt: activity,
          activeRunId: RunId.make(`run-${id}`),
          activityRunStatus: "running" as const,
          activityRunStartedAt: activity,
          status: "running" as const,
        }
      : {}),
    pendingBackgroundTasks: options.pending ?? [],
    settledOverride: options.settled ? "settled" : null,
    settledAt: options.settled ? at("2026-10-13T11:00:00.000Z") : null,
    ...(options.approval ? { pendingRuntimeRequest: { kind: "command_approval" } as never } : {}),
  };
  return {
    ...presentThreadShell(env, v2),
    parentThreadId: parent,
    subproject: "auto",
    purpose: options.purpose ?? null,
    supervisionMetadataPresent: true,
  };
}

/**
 * A project and its tree as the stores hold them: a worker, a Claude Task subagent still going, a
 * Codex native subagent under that worker (a chain) that has finished, a delegate_task child
 * mid-run and a settled delegate child.
 */
const forest = () => [
  shell("orch", { kind: "root" }),
  shell("worker", { kind: "worker", parent: "orch" }),
  shell("claude-task", {
    kind: "native",
    parent: "orch",
    title: "Subagent: Explore the cache layer",
  }),
  shell("codex-native", {
    kind: "native",
    parent: "worker",
    title: "/root/review_runner",
    settled: true,
    activity: "2026-10-13T09:00:00.000Z",
  }),
  shell("delegate", {
    kind: "delegate",
    parent: "orch",
    running: true,
    title: "Fix the flake",
    activity: "2026-10-13T10:30:00.000Z",
  }),
  shell("delegate-done", {
    kind: "delegate",
    parent: "orch",
    settled: true,
    title: "Old delegated task",
    activity: "2026-10-13T08:00:00.000Z",
  }),
];
/** The roster entry that says the Claude Task child is running, since its own shell reads idle. */
const withRunningTask = (threads: OrchestratorThreadShell[]) =>
  threads.map((thread) =>
    thread.id === "orch"
      ? {
          ...thread,
          pendingBackgroundTasks: [
            {
              taskId: "task-1",
              kind: "subagent" as const,
              childThreadId: ThreadId.make("claude-task"),
            },
          ],
        }
      : thread,
  );
const summaryOf = (threads: OrchestratorThreadShell[], id = "orch") =>
  buildOrchestratorSummaries(threads, []).find((item) => item.root.id === id)!;
const titles = (rows: ReadonlyArray<{ readonly thread: { readonly title: string } }>) =>
  rows.map((row) => row.thread.title);

describe("subagent rows", () => {
  it("lists a nested native subagent as a row of its project, with a formatted title", () => {
    const row = summaryOf(forest()).subagentRows.find((item) => item.thread.id === "claude-task")!;
    expect(row.thread.title).toBe("Explore the cache layer");
    expect(row.parentKey).toBe("env:orch");
    expect(row.readOnly).toBe(true);
  });

  it("lists a delegate_task child and a worker as writable, and only provider-native ones as read-only", () => {
    const rows = summaryOf(forest()).subagentRows;
    const readOnly = Object.fromEntries(rows.map((row) => [row.thread.id, row.readOnly]));
    expect(readOnly).toEqual({
      "claude-task": true,
      "codex-native": true,
      delegate: false,
      "delegate-done": false,
      worker: false,
    });
  });

  it("does not list the root as a row", () => {
    const ids = summaryOf(forest()).subagentRows.map((row) => row.thread.id);
    expect(ids).not.toContain("orch");
  });

  it("lists a nested worker as a writable worker row, subagents keeping their kind", () => {
    const rows = summaryOf(forest()).subagentRows;
    expect(Object.fromEntries(rows.map((row) => [row.thread.id, row.kind]))).toEqual({
      worker: "worker",
      "claude-task": "subagent",
      "codex-native": "subagent",
      delegate: "subagent",
      "delegate-done": "subagent",
    });
    expect(rows.find((row) => row.thread.id === "worker")).toMatchObject({
      parentKey: "env:orch",
      readOnly: false,
      working: false,
      settled: false,
    });
  });

  it("lists a subthread the user nested under a head, the same as a CLI worker", () => {
    const threads = [
      shell("orch"),
      shell("mine", { kind: "worker", parent: "orch", userCreated: true, title: "My subthread" }),
    ];
    expect(summaryOf(threads).subagentRows.map((row) => [row.thread.title, row.kind])).toEqual([
      ["My subthread", "worker"],
    ]);
  });

  it("leaves out forks, system threads and threads the user opened through a server action", () => {
    const threads = [
      shell("orch"),
      shell("forked", { kind: "fork", parent: "orch" }),
      shell("sys", { kind: "worker", parent: "orch", createdBy: "system" }),
      shell("discuss", {
        kind: "worker",
        parent: "orch",
        createdBy: "user",
        creationSource: "server",
      }),
    ];
    expect(summaryOf(threads).subagentRows).toEqual([]);
    // The Discuss thread stays where it was: in Threads.
    expect(threadsVisibleInThreadsMode(threads, true).map((thread) => thread.id)).toContain(
      "discuss",
    );
  });

  it("orders a working worker first and folds a settled one into Settled", () => {
    const threads = [
      shell("orch"),
      shell("idle", { kind: "worker", parent: "orch", activity: "2026-10-13T11:00:00.000Z" }),
      shell("busy", { kind: "worker", parent: "orch", running: true }),
      shell("done", { kind: "worker", parent: "orch", settled: true }),
    ];
    const { active, settled } = splitSettledSubagents(summaryOf(threads).subagentRows);
    expect(active.map((row) => row.thread.id)).toEqual(["busy", "idle"]);
    expect(settled.map((row) => row.thread.id)).toEqual(["done"]);
  });

  it("lists every nested worker of a head with no cap", () => {
    const threads = [
      shell("orch"),
      ...Array.from({ length: 35 }, (_, index) =>
        shell(`w${index}`, { kind: "worker", parent: "orch", userCreated: true }),
      ),
    ];
    expect(summaryOf(threads).subagentRows).toHaveLength(35);
    expect(subagentCountLabel(summaryOf(threads).subagentRows)).toBe("35 agents");
  });

  it("leaves the rollup as it is with and without worker rows", () => {
    const tree = (createdBy: "agent" | "system") => [
      shell("orch"),
      shell("busy", { kind: "worker", parent: "orch", running: true, createdBy }),
      shell("idle", { kind: "worker", parent: "orch", createdBy }),
    ];
    // The system-created pair is the same tree with no worker rows.
    const withRows = summaryOf(tree("agent"));
    const withoutRows = summaryOf(tree("system"));
    expect(withRows.subagentRows).toHaveLength(2);
    expect(withoutRows.subagentRows).toHaveLength(0);
    expect(withRows.rollup.working).toBe(1);
    expect(withRows.rollup.needsYou).toBe(0);
    expect(withRows.rollup).toEqual(withoutRows.rollup);
    expect(withRows.activeWorkerCount).toBe(withoutRows.activeWorkerCount);
    expect(withRows.descendants).toHaveLength(2);
  });

  it("orders running before recent before settled, settled by recency", () => {
    const threads = withRunningTask(forest());
    threads.push(
      shell("recent-idle", {
        kind: "delegate",
        parent: "orch",
        title: "Finished, not settled",
        activity: "2026-10-13T09:30:00.000Z",
      }),
    );
    const rows = summaryOf(threads).subagentRows;
    expect(titles(rows)).toEqual([
      // running: the delegate's own run and the Claude Task child via the parent's roster
      "Fix the flake",
      "Explore the cache layer",
      "worker",
      "Finished, not settled",
      "Review Runner",
      "Old delegated task",
    ]);
    const { active, settled } = splitSettledSubagents(rows);
    expect(titles(active)).toEqual([
      "Fix the flake",
      "Explore the cache layer",
      "worker",
      "Finished, not settled",
    ]);
    expect(titles(settled)).toEqual(["Review Runner", "Old delegated task"]);
  });

  it("reads a runless native child as working only through its parent's task roster", () => {
    const child = shell("claude-task", { kind: "native", parent: "orch" });
    // The shell as stored: no run, no runtime status that counts as work.
    expect(child.latestRun).toBeNull();
    expect(child.runtime?.status ?? "idle").toBe("idle");
    const idle = summaryOf([shell("orch"), child]).subagentRows[0]!;
    expect(idle.working).toBe(false);
    const running = summaryOf(withRunningTask([shell("orch"), child])).subagentRows[0]!;
    expect(running.working).toBe(true);
    expect(running.settled).toBe(false);
  });

  it("keeps a settled row out of Settled while it is working or waiting on you", () => {
    const threads = [
      shell("orch"),
      shell("busy", { kind: "delegate", parent: "orch", settled: true, running: true }),
      shell("asks", { kind: "delegate", parent: "orch", settled: true, approval: true }),
    ];
    const rows = summaryOf(threads).subagentRows;
    expect(rows.map((row) => [row.thread.id, row.settled])).toEqual(
      expect.arrayContaining([
        ["busy", false],
        ["asks", false],
      ]),
    );
  });

  it("puts a subagent of a worker under the project, with the worker as its parent", () => {
    const row = summaryOf(forest()).subagentRows.find((item) => item.thread.id === "codex-native")!;
    expect(row.parentKey).toBe("env:worker");
    expect(row.parentTitle).toBe("worker");
  });

  it("puts a subagent of a subproject's worker under the subproject, not the project", () => {
    const threads = [
      shell("orch"),
      { ...shell("sub", { kind: "worker", parent: "orch" }), subproject: "on" as const },
      shell("sub-worker", { kind: "worker", parent: "sub" }),
      shell("deep", { kind: "native", parent: "sub-worker", title: "Subagent: Deep" }),
    ];
    expect(summaryOf(threads, "orch").subagentRows).toEqual([]);
    expect(titles(summaryOf(threads, "sub").subagentRows)).toEqual(["Deep", "sub-worker"]);
  });

  it("leaves every rollup count as it was", () => {
    const threads = withRunningTask(forest());
    const withRows = summaryOf(threads);
    const plain = summaryOf(
      threads.map((thread) =>
        thread.lineage.relationshipToParent === "subagent"
          ? { ...thread, lineage: { ...thread.lineage, relationshipToParent: null } }
          : thread,
      ),
    );
    // Same tree either way: only the running delegate counts as work, the runless child does not.
    expect(withRows.rollup).toEqual(plain.rollup);
    expect(withRows.rollup.working).toBe(1);
    expect(withRows.activeWorkerCount).toBe(plain.activeWorkerCount);
    expect(withRows.descendants).toHaveLength(5);
    expect(withRows.subprojects).toEqual([]);
  });

  it("counts an approval waiting in a subagent once, as it did before", () => {
    const threads = [
      shell("orch"),
      shell("asks", { kind: "native", parent: "orch", approval: true }),
    ];
    const summary = summaryOf(threads);
    expect(summary.rollup.needsYou).toBe(1);
    expect(summary.subagentRows[0]!.needsYou).toBe(true);
  });

  it("labels a folded card by its unsettled rows and merges settled ones into the Settled count", () => {
    const summary = summaryOf(withRunningTask(forest()));
    expect(subagentCountLabel(summary.subagentRows)).toBe("3 agents");
    expect(subagentCountLabel([])).toBeNull();
    const group = settledGroupSummary(
      [],
      splitSettledSubagents(summary.subagentRows).settled.length,
    );
    expect(group.label).toBe("Settled (2)");
    expect(group.description).toBe("2 settled subagents and workers");
    // Without subagents the label is what it was.
    expect(settledGroupSummary([summary]).label).toBe("Settled (1)");
    expect(settledGroupSummary([summary]).description).toBe("1 settled subproject");
  });
});

describe("subagent rows and purpose", () => {
  it("drops a Harness-purpose worker from a Projects card", () => {
    const threads = [
      shell("orch", { purpose: "project" }),
      shell("plain", { kind: "worker", parent: "orch", title: "Plain worker" }),
      shell("harness-worker", {
        kind: "worker",
        parent: "orch",
        title: "Harness worker",
        purpose: "harness",
      }),
    ];
    expect(titles(projectSubagentRows(summaryOf(threads), threadPurposes(threads)))).toEqual([
      "Plain worker",
    ]);
  });

  it("keeps a Harness root's subagents out of Projects", () => {
    const threads = [
      shell("orch", { purpose: "harness" }),
      shell("helper", { kind: "native", parent: "orch" }),
    ];
    const { projects, harness } = partitionThreadPurposes(
      threads,
      buildOrchestratorSummaries(threads, []),
    );
    expect(projects).toEqual([]);
    expect(harness).toHaveLength(1);
  });

  it("drops a Harness subagent from a Projects card but keeps its project-purpose siblings", () => {
    const threads = [
      shell("orch", { purpose: "project" }),
      shell("plain", { kind: "native", parent: "orch", title: "Subagent: Plain" }),
      shell("harness-helper", {
        kind: "native",
        parent: "orch",
        title: "Subagent: Harness helper",
        purpose: "harness",
      }),
    ];
    const summary = summaryOf(threads);
    const purposes = threadPurposes(threads);
    expect(titles(projectSubagentRows(summary, purposes))).toEqual(["Plain"]);
    expect(titles(summary.subagentRows).toSorted()).toEqual(["Harness helper", "Plain"]);
  });
});

describe("threads list with subagents", () => {
  it("keeps a user-created root in Threads and its subagents out", () => {
    const threads = [
      shell("mine", { userCreated: true }),
      shell("child", { kind: "native", parent: "mine" }),
    ];
    expect(threadsVisibleInThreadsMode(threads, true).map((thread) => thread.id)).toEqual(["mine"]);
  });

  it("keeps a project's subagents out of Threads", () => {
    expect(threadsVisibleInThreadsMode(forest(), true)).toEqual([]);
  });
});

describe("owningProjectRoot", () => {
  const row = (threadId: string, parentThreadId: string | null, subproject?: "on") => ({
    environmentId: "env",
    threadId: ThreadId.make(threadId),
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    ...(subproject ? { subproject } : {}),
  });
  const start = (threadId: string, lineageParentId?: string) => ({
    environmentId: "env",
    threadId,
    ...(lineageParentId ? { lineageParentId } : {}),
  });

  it("finds the project root above a subagent of a worker", () => {
    const metadata = [row("orch", null), row("worker", "orch"), row("deep", "worker")];
    expect(owningProjectRoot(metadata, start("deep"))).toEqual({
      environmentId: "env",
      threadId: "orch",
    });
  });

  it("stops at the nearest subproject", () => {
    const metadata = [
      row("orch", null),
      row("sub", "orch", "on"),
      row("worker", "sub"),
      row("deep", "worker"),
    ];
    expect(owningProjectRoot(metadata, start("deep"))?.threadId).toBe("sub");
  });

  it("uses native lineage for a subagent the sidecar has no row for yet", () => {
    const metadata = [row("orch", null)];
    expect(owningProjectRoot(metadata, start("fresh", "orch"))?.threadId).toBe("orch");
  });

  it("gives a standalone thread, a project root and a cycle no way back", () => {
    expect(owningProjectRoot([row("solo", null)], start("solo"))).toBeNull();
    expect(owningProjectRoot([row("orch", null), row("w", "orch")], start("orch"))).toBeNull();
    expect(owningProjectRoot([row("a", "b"), row("b", "a")], start("a"))).toBeNull();
  });
});
