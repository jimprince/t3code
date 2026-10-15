// @vitest-environment jsdom
import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import { subprojectCountLabel } from "@t3tools/client-runtime/state/projectSubprojects";
import { buildOrchestratorSummaries } from "@t3tools/client-runtime/state/orchestrators";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";

const shells = vi.hoisted(() => ({ current: [] as ReadonlyArray<unknown> }));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useParams: () => null,
}));
vi.mock("./useOrchestratorThreads", () => ({ useOrchestratorThreadShells: () => shells.current }));
vi.mock("../../state/entities", () => ({
  useProjects: () => [],
  readEnvironmentSupportsPinReorder: () => false,
}));
vi.mock("../../state/environments", () => ({ useEnvironments: () => ({ environments: [] }) }));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ pinThread: vi.fn(), reorderPinnedThread: vi.fn() }),
}));
vi.mock("../../hooks/useThreadActionMenu", () => ({ useThreadActionMenu: () => vi.fn() }));
vi.mock("../ProjectFavicon", () => ({ ProjectFavicon: () => null }));

import { OrchestratorSidebarList } from "./OrchestratorSidebarList";

const now = new Date().toISOString();
const DEV = EnvironmentId.make("dev");
const MAC = EnvironmentId.make("mac");

function shell(
  id: string,
  options: {
    title: string;
    parent?: string;
    remoteParent?: { environmentId: string; threadId: ThreadId };
    purpose?: "project" | "harness";
    worker?: boolean;
    settled?: boolean;
    environmentId?: EnvironmentId;
    activity?: string;
  },
): OrchestratorThreadShell {
  return {
    ...makeThreadFixture({
      id: ThreadId.make(id),
      environmentId: options.environmentId ?? DEV,
      title: options.title,
      latestUserMessageAt: options.activity ?? now,
      settledOverride: options.settled ? "settled" : null,
    }),
    parentThreadId: options.parent ? ThreadId.make(options.parent) : null,
    remoteParent: options.remoteParent
      ? {
          environmentId: options.remoteParent.environmentId,
          threadId: options.remoteParent.threadId,
        }
      : null,
    subproject: (options.parent || options.remoteParent) && !options.worker ? "on" : "auto",
    purpose: options.purpose ?? null,
    supervisionMetadataPresent: true,
  };
}

/** The shape of Brad's live Projects tab (2026-10-13): a project whose active children are mostly Harness. */
const liveShape = () => [
  shell("orchestrator", { title: "T3 Orchestrator", purpose: "project" }),
  shell("orchestrator-worker", { title: "Worker", parent: "orchestrator", worker: true }),
  shell("reliability", { title: "Reliability", parent: "orchestrator", purpose: "harness" }),
  shell("product", { title: "T3 Product", parent: "orchestrator", purpose: "harness" }),
  shell("dashboard", { title: "Dashboard", parent: "product" }),
  shell("delivery-tools", { title: "Delivery tooling", parent: "orchestrator" }),
  shell("v2-port", { title: "V2 Port", parent: "orchestrator", settled: true }),
  shell("retired", { title: "Retired lane", parent: "orchestrator", settled: true }),
  shell("clinic", { title: "Clinic Scheduler" }),
  shell("clinic-worker", { title: "Clinic worker", parent: "clinic", worker: true }),
  shell("delivery", {
    title: "Delivery",
    environmentId: MAC,
    remoteParent: { environmentId: DEV, threadId: ThreadId.make("clinic") },
  }),
];

const render = () => renderToStaticMarkup(<OrchestratorSidebarList />);
const opens = (markup: string) =>
  [...markup.matchAll(/aria-label="Open ([^"]+) subproject"/g)].map((match) => match[1]);

beforeEach(() => {
  shells.current = liveShape();
});

describe("Projects sidebar card subprojects", () => {
  it("lists every active subproject of a project, whatever its purpose", () => {
    expect(opens(render()).toSorted()).toEqual([
      "Dashboard",
      "Delivery",
      "Delivery tooling",
      "Reliability",
      "T3 Product",
    ]);
  });

  it("tags a Harness subproject of a project, and only the one that differs from its parent", () => {
    const markup = render();
    // A row is an overlay button then its content, up to the next row's button.
    const rowOf = (title: string) =>
      markup
        .slice(markup.indexOf(`aria-label="Open ${title} subproject"`) + 1)
        .split(/aria-label="Open [^"]+ subproject"/)[0]!;
    expect(rowOf("Reliability")).toContain(">Harness<");
    expect(rowOf("T3 Product")).toContain(">Harness<");
    expect(rowOf("Dashboard")).not.toContain(">Harness<");
    expect(rowOf("Delivery tooling")).not.toContain(">Harness<");
  });

  it("keeps settled subprojects in the collapsed Settled row", () => {
    const markup = render();
    expect(markup).toContain("Settled (2)");
    expect(markup).not.toContain("Open V2 Port subproject");
    expect(markup).not.toContain("Open Retired lane subproject");
  });

  it("shows a count that matches the rows listed", () => {
    const summaries = buildOrchestratorSummaries(
      shells.current as ReadonlyArray<OrchestratorThreadShell>,
      [],
    );
    const orchestrator = summaries.find((summary) => summary.root.id === "orchestrator")!;
    expect(subprojectCountLabel(orchestrator)).toBe("4 subs");
    const inCard = opens(render()).filter((title) => title !== "Delivery");
    expect(inCard).toHaveLength(4);
  });
});

/** A subagent as the stores hold it: lineage "subagent", provider-created when native. */
function subagent(
  id: string,
  parent: string,
  kind: "native" | "delegate",
  options: { title: string; settled?: boolean; activity?: string; purpose?: "harness" },
): OrchestratorThreadShell {
  const base = shell(id, { ...options, parent, worker: true });
  const lineage = {
    rootThreadId: ThreadId.make(parent),
    parentThreadId: ThreadId.make(parent),
    relationshipToParent: "subagent" as const,
  };
  return {
    ...base,
    lineage,
    source: {
      ...base.source,
      lineage,
      createdBy: "agent",
      creationSource: kind === "native" ? "provider" : "mcp",
    },
  };
}
const opensAgents = (markup: string) =>
  [...markup.matchAll(/aria-label="Open ([^"]+) subagent"/g)].map((match) => match[1]);
const agentRow = (markup: string, title: string) =>
  markup.slice(markup.indexOf(`aria-label="Open ${title} subagent"`)).split("</button>")[0]!;
const opensWorkers = (markup: string) =>
  [...markup.matchAll(/aria-label="Open ([^"]+) worker"/g)].map((match) => match[1]);
const workerRow = (markup: string, title: string) =>
  markup.slice(markup.indexOf(`aria-label="Open ${title} worker"`)).split("</button>")[0]!;

describe("Projects sidebar card subagents", () => {
  beforeEach(() => {
    const [orchestrator, ...rest] = liveShape();
    shells.current = [
      {
        ...orchestrator!,
        // The roster says the Claude Task child is still going; its own shell reads idle.
        pendingBackgroundTasks: [
          { taskId: "t1", kind: "subagent", childThreadId: ThreadId.make("claude-task") },
        ],
      },
      ...rest,
      subagent("claude-task", "orchestrator", "native", {
        title: "Explore the cache layer",
        activity: "2026-10-13T09:00:00.000Z",
      }),
      subagent("delegate", "orchestrator", "delegate", {
        title: "Fix the flake",
        activity: "2026-10-13T10:00:00.000Z",
      }),
      subagent("deep", "orchestrator-worker", "native", {
        title: "Review runner",
        activity: "2026-10-13T08:00:00.000Z",
      }),
      subagent("old", "orchestrator", "delegate", { title: "Old task", settled: true }),
      subagent("harness-helper", "orchestrator", "native", {
        title: "Harness helper",
        purpose: "harness",
      }),
    ];
  });

  it("lists nested subagents under their project, a worker's too: working first, then newest", () => {
    expect(opensAgents(render())).toEqual([
      "Explore the cache layer",
      "Fix the flake",
      "Review runner",
    ]);
  });

  it("tags only provider-native subagents read-only and names a worker as the parent", () => {
    const markup = render();
    expect(agentRow(markup, "Explore the cache layer")).toContain(">read-only<");
    expect(agentRow(markup, "Fix the flake")).not.toContain("read-only");
    expect(agentRow(markup, "Review runner")).toContain("· Worker");
    expect(agentRow(markup, "Fix the flake")).not.toContain("·");
  });

  it("shows the running subagent with the working dot", () => {
    expect(agentRow(render(), "Explore the cache layer")).toContain("bg-info");
  });

  it("folds settled subagents into the one Settled row with the settled subprojects", () => {
    const markup = render();
    expect(markup).toContain("Settled (3)");
    expect(markup).not.toContain("Open Old task subagent");
  });

  it("keeps a Harness subagent off the Projects card", () => {
    expect(opensAgents(render())).not.toContain("Harness helper");
  });

  it("leaves the subproject rows and their count as they were", () => {
    const markup = render();
    expect(opens(markup).filter((title) => title !== "Delivery")).toHaveLength(4);
    const summaries = buildOrchestratorSummaries(
      shells.current as ReadonlyArray<OrchestratorThreadShell>,
      [],
    );
    expect(
      subprojectCountLabel(summaries.find((summary) => summary.root.id === "orchestrator")!),
    ).toBe("4 subs");
  });
});

describe("Projects sidebar card workers", () => {
  it("lists a nested subthread as a worker row under its head, tagged worker and clickable", () => {
    shells.current = [
      ...liveShape(),
      shell("mine", {
        title: "T3 Code Performance Bottlenecks",
        parent: "orchestrator",
        worker: true,
      }),
    ];
    const markup = render();
    expect(opensWorkers(markup)).toContain("T3 Code Performance Bottlenecks");
    expect(workerRow(markup, "T3 Code Performance Bottlenecks")).toContain(">worker<");
    // A worker row is not a subagent row, and the card has a chevron to fold it.
    expect(opensAgents(markup)).not.toContain("T3 Code Performance Bottlenecks");
    expect(markup).toContain("Hide subprojects of T3 Orchestrator");
  });

  it("lists a head whose only children are workers with a fold control", () => {
    shells.current = [
      shell("head", { title: "Lone head", purpose: "project" }),
      shell("kid", { title: "Only child", parent: "head", worker: true }),
    ];
    const markup = render();
    expect(opensWorkers(markup)).toEqual(["Only child"]);
    expect(markup).toContain("Hide agents of Lone head");
  });

  it("keeps a Harness-purpose worker off the Projects card", () => {
    shells.current = [
      ...liveShape(),
      shell("h", {
        title: "Harness chore",
        parent: "orchestrator",
        worker: true,
        purpose: "harness",
      }),
    ];
    expect(opensWorkers(render())).not.toContain("Harness chore");
  });
});
