import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const navigate = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigate }));
// Importing the sections pulls in their data hooks; opening a thread uses none of them.
vi.mock("../../state/entities", () => ({ waitForThreadShell: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../hooks/useLocalStorage", () => ({ useLocalStorage: vi.fn() }));
vi.mock("./ProjectRoadmapWidget", () => ({ useNextReleaseItems: vi.fn() }));

import { useOpenThread } from "./ProjectRequestsSection";

const identity = (environmentId: string, id: string) =>
  ({ environmentId: EnvironmentId.make(environmentId), id: ThreadId.make(id) }) as never;

// A project whose head lives on dev-vm and whose standing agent lives on the Mac.
const summary = {
  root: identity("dev-vm", "root"),
  descendants: [identity("local-mbp", "remote-child"), identity("dev-vm", "local-child")],
} as unknown as OrchestratorSummary;

let tree: ReactTestRenderer | null = null;
afterEach(() => {
  act(() => tree?.unmount());
  tree = null;
  navigate.mockClear();
});

/** Mounts the hook the Task panel, Team strip and thread rows share, and returns its opener. */
function mountOpenThread() {
  const opener: { open: ReturnType<typeof useOpenThread> | null } = { open: null };
  function Probe() {
    opener.open = useOpenThread(summary);
    return null;
  }
  act(() => {
    tree = create(<Probe />);
  });
  return opener.open!;
}

describe("useOpenThread", () => {
  it("opens a task's linked thread that lives on another machine in that machine's environment", () => {
    // ProjectTaskPanel and the workstream rows hand it only the bare thread id.
    mountOpenThread()("remote-child");
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "local-mbp", threadId: "remote-child" },
      state: { projectReturn: { environmentId: "dev-vm", threadId: "root" } },
    });
  });

  it("opens a Team member with the environment it carries", () => {
    mountOpenThread()("remote-child", EnvironmentId.make("local-mbp"));
    expect(navigate.mock.calls[0]![0].params).toEqual({
      environmentId: "local-mbp",
      threadId: "remote-child",
    });
  });

  it("opens a same-environment thread exactly as before", () => {
    mountOpenThread()("local-child");
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "dev-vm", threadId: "local-child" },
      state: { projectReturn: { environmentId: "dev-vm", threadId: "root" } },
    });
  });
});
