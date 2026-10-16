// @vitest-environment jsdom
import type { OrchestratorThreadShell } from "@t3tools/client-runtime/state/orchestrators";
import { buildSubheadRows } from "@t3tools/client-runtime/state/subheads-view";
import {
  EnvironmentId,
  NamedAgentName,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Subhead,
  type SubheadRunRow,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../../test-fixtures";

const NOW = "2026-10-16T09:00";
const DEV = EnvironmentId.make("dev");
const state = vi.hoisted(() => ({
  shells: [] as ReadonlyArray<unknown>,
  environments: [] as ReadonlyArray<unknown>,
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn(), useParams: () => null }));
vi.mock("../ui/sidebar", () => ({
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("../../hooks/useNowMinute", () => ({ useNowMinute: () => NOW }));
vi.mock("../../hooks/useThreadActionMenu", () => ({
  useThreadActionMenu: () => ({ openMenu: vi.fn() }),
}));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/harness", () => ({
  useHarnessEnvironments: () => ({ environments: [], refresh: vi.fn() }),
}));
vi.mock("../../state/subheads", () => ({ useSubheadEnvironments: () => state.environments }));
vi.mock("../orchestrators/useOrchestratorThreads", () => ({
  useOrchestratorThreadShells: () => state.shells,
}));
vi.mock("../orchestrators/OrchestratorSidebarList", () => ({ useSelectedRoute: () => null }));
vi.mock("./useHarnessCheckPin", () => ({ useHarnessCheckPin: () => ({ openMenu: vi.fn() }) }));

import { HarnessSidebarList } from "./HarnessSidebarList";

const head = (id: string, title: string): OrchestratorThreadShell => ({
  ...makeThreadFixture({ id: ThreadId.make(id), environmentId: DEV, title }),
  parentThreadId: null,
  remoteParent: null,
  subproject: "auto",
  purpose: "harness",
  supervisionMetadataPresent: true,
});
const subhead = (name: string, owner: string): Subhead => ({
  id: `id-${name}`,
  kind: "virtual",
  version: 1,
  enabled: true,
  retiredAt: null,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T10:00:00.000Z",
  name: NamedAgentName.make(name),
  projectId: ProjectId.make("project"),
  ownerThreadId: ThreadId.make(owner),
  description: "",
  prompt: "Do it.",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" },
  runtimeMode: "approval-required",
  concurrency: 1,
});
const failed = (name: string, at: string): SubheadRunRow => ({
  runId: `run-${name}`,
  agentId: `id-${name}`,
  subheadName: NamedAgentName.make(name),
  requestId: "r",
  requestSummary: "Review",
  senderPrincipal: "owner",
  senderThreadId: null,
  templateVersion: 1,
  status: "failed",
  threadId: null,
  delivery: { id: "d", status: "pull-only", messageId: null, attempts: 0, error: null },
  blockedReason: null,
  terminationReason: null,
  createdAt: at,
  finishedAt: at,
});

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (runs: ReadonlyArray<SubheadRunRow>) => {
  state.shells = [head("quiet", "Quiet head"), head("busy", "Busy head")];
  state.environments = [
    {
      environmentId: DEV,
      label: "dev",
      error: null,
      rows: buildSubheadRows({
        environmentId: DEV,
        subheads: [subhead("stale-check", "quiet"), subhead("fresh-check", "busy")],
        runs,
      }),
    },
  ];
  act(() => root.render(<HarnessSidebarList />));
};

describe("HarnessSidebarList subheads", () => {
  it("lists a head among the active ones for a failure from the last day, not for an old one", () => {
    render([
      failed("stale-check", "2026-10-10T09:00:00.000Z"),
      failed("fresh-check", "2026-10-16T08:00:00.000Z"),
    ]);
    const agents = container.querySelector("section[aria-label='Harness agents']")!;
    // The head with the failure from the last day is promoted and shows its subhead; the other stays
    // behind "Show 1 idle" and its subhead is not listed until that is opened.
    expect(agents.textContent).toContain("Busy head");
    expect(agents.textContent).toContain("fresh-check");
    expect(agents.textContent).toContain("1 of 2 active");
    expect(agents.textContent).toContain("Show 1 idle");
    expect(agents.textContent).not.toContain("stale-check");
    act(() =>
      [...agents.querySelectorAll("button")]
        .find((button) => button.textContent?.includes("Show 1 idle"))!
        .click(),
    );
    // Opened, the old failure is still on its subhead row.
    expect(agents.textContent).toContain("stale-check");
    expect(agents.textContent).toContain("last failed");
  });
});
