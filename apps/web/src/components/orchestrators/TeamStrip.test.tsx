import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
vi.mock("../../state/entities", () => ({ waitForThreadShell: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: vi.fn() }));
vi.mock("./ProjectRoadmapWidget", () => ({ useNextReleaseItems: vi.fn() }));

import type { TeamMember } from "./workstreamTeam.logic";
import { TeamStrip } from "./WorkstreamBands";

const identity = (environmentId: string, id: string) =>
  ({ environmentId: EnvironmentId.make(environmentId), id: ThreadId.make(id) }) as never;

const member = (environmentId: string, threadId: string, head = false): TeamMember => ({
  threadId,
  environmentId: EnvironmentId.make(environmentId),
  title: `Agent ${threadId}`,
  head,
  tag: "idle",
  responsibility: null,
  owns: null,
  latest: null,
  at: "2026-10-15T00:00:00.000Z",
});

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  navigate.mockClear();
});

it("opens a Team member that runs on another machine in that machine's environment", () => {
  const summary = {
    root: identity("dev-vm", "root"),
    // The member carries its own environment; the strip must not need the project to list it.
    descendants: [],
  } as unknown as OrchestratorSummary;
  act(() => {
    tree = create(
      <TeamStrip
        summary={summary}
        team={[member("dev-vm", "root", true), member("local-mbp", "remote-agent")]}
        now={Date.parse("2026-10-15T01:00:00.000Z")}
      />,
    );
  });
  const textOf = (node: ReactTestInstance): string =>
    node.children.map((child) => (typeof child === "string" ? child : textOf(child))).join("");
  const open = (title: string) =>
    tree!.root.findAll((node) => node.type === "button" && textOf(node).includes(title));
  act(() => open("Agent remote-agent")[0]!.props.onClick());
  expect(navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId: "local-mbp", threadId: "remote-agent" },
    state: { projectReturn: { environmentId: "dev-vm", threadId: "root" } },
  });
});
