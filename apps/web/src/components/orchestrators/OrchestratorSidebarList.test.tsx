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
  },
): OrchestratorThreadShell {
  return {
    ...makeThreadFixture({
      id: ThreadId.make(id),
      environmentId: options.environmentId ?? DEV,
      title: options.title,
      latestUserMessageAt: now,
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
    const rowOf = (title: string) =>
      markup.slice(markup.indexOf(`aria-label="Open ${title} subproject"`)).split("</button>")[0]!;
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
