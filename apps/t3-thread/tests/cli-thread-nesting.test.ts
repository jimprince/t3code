import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OrchestrationThreadShell, StateFile } from "../src/types.js";
import { selectThreadChildren } from "../src/status.js";

const fixture = vi.hoisted(() => ({ state: null as StateFile | null }));
vi.mock("../src/state.js", async (original) => ({
  ...(await original<typeof import("../src/state.js")>()),
  loadState: async () => fixture.state!,
  updateState: async (
    update: (state: StateFile) => Promise<{ state: StateFile; result: unknown }>,
  ) => {
    const changed = await update(fixture.state!);
    fixture.state = changed.state;
    return changed.result;
  },
}));
const timestamp = "2026-10-02T00:00:00.000Z";
const rootId = "11111111-1111-4111-8111-111111111111";
const childId = "22222222-2222-4222-8222-222222222222";
const grandchildId = "33333333-3333-4333-8333-333333333333";
function shell(id: string, parentThreadId: string | null, title: string): OrchestrationThreadShell {
  return {
    id,
    parentThreadId,
    title,
    projectId: "project",
    modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    session: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}
const threads = [
  shell(rootId, null, "Supervisor"),
  { ...shell(childId, rootId, "Worker"), settledOverride: "settled" as const, pinnedAt: timestamp },
  shell(grandchildId, childId, "Nested worker"),
  shell("unrelated", null, "Other"),
];
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function run(args: string[], remote = false, caller = "") {
  fixture.state = {
    version: 1,
    environments: [
      {
        name: "local",
        httpBaseUrl: "http://127.0.0.1:1",
        wsBaseUrl: "ws://127.0.0.1:1",
        environmentId: "local",
        label: "Local",
        serverVersion: "test",
        bearerToken: "test",
        expiresAt: "2099-01-01T00:00:00.000Z",
        pairedAt: timestamp,
      },
    ],
    agents: [
      {
        name: "supervisor",
        environment: "local",
        threadId: rootId,
        projectId: "project",
        title: "Supervisor",
        createdAt: timestamp,
        lastSeenAssistantMessageId: null,
      },
    ],
    subscriptions: [],
    notifications: [],
    queuedSends: [],
  };
  fixture.state.agents.push({
    ...fixture.state.agents[0]!,
    name: "worker",
    threadId: childId,
    title: "Worker",
  });
  if (remote) {
    fixture.state.environments.push({
      ...fixture.state.environments[0]!,
      name: "laptop",
      environmentId: "laptop-id",
    });
    fixture.state.agents[1]!.environment = "laptop";
  }
  vi.stubEnv("T3_THREAD_ID", caller);
  vi.resetModules();
  const { RemoteEnvironmentClient } = await import("../src/client.js");
  const list = vi
    .spyOn(RemoteEnvironmentClient.prototype, "listThreads")
    .mockResolvedValue(threads);
  const detail = vi
    .spyOn(RemoteEnvironmentClient.prototype, "findThread")
    .mockImplementation(async (id) => ({
      ...threads.find((thread) => thread.id === id)!,
      messages: [],
      activities: [],
      checkpoints: [],
      proposedPlans: [],
    }));
  const remoteParent = { environmentId: "local", threadId: rootId };
  vi.spyOn(RemoteEnvironmentClient.prototype, "describe").mockResolvedValue({
    environmentId: "local",
    label: "Local",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: { threadNesting: true, remoteThreadNesting: true },
  });
  vi.spyOn(RemoteEnvironmentClient.prototype, "supportsThreadNesting").mockResolvedValue(true);
  vi.spyOn(RemoteEnvironmentClient.prototype, "getShellSnapshot").mockResolvedValue({
    snapshotSequence: 0,
    projects: [],
    threads: [],
  });
  const create = vi
    .spyOn(RemoteEnvironmentClient.prototype, "createAgentThread")
    .mockResolvedValue({ threadId: childId, projectId: "project", title: "Worker", pinned: false });
  let currentParent: typeof remoteParent | null = remoteParent;
  const setParent = vi
    .spyOn(RemoteEnvironmentClient.prototype, "setThreadParent")
    .mockImplementation(async (_id, _local, parent) => {
      currentParent = parent ?? null;
    });
  vi.spyOn(RemoteEnvironmentClient.prototype, "getThreadDetail").mockImplementation(async () => ({
    ...threads[1]!,
    parentThreadId: null,
    remoteParent: currentParent,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
  }));
  let finish!: (value: string) => void;
  const printed = new Promise<string>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    finish(String(chunk));
    return true;
  });
  process.argv = [process.execPath, "cli.ts", ...args];
  await import("../src/cli.js");
  return { output: await printed, list, detail, create, setParent };
}

describe("CLI nesting readback", () => {
  it("automatically nests a laptop worker under its VM caller", async () => {
    const { output, create } = await run(
      [
        "create",
        "--name",
        "new-worker",
        "--env",
        "laptop",
        "--project",
        "project",
        "--title",
        "Worker",
        "--message",
        "work",
        "--no-notify",
      ],
      true,
      rootId,
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        parentThreadId: null,
        remoteParent: { environmentId: "local", threadId: rootId },
      }),
    );
    expect(JSON.parse(output)).toMatchObject({ nesting: "remote" });
  });
  it.each(["supervisor", rootId])(
    "creates a laptop child under remote parent %s",
    async (parent) => {
      const { output, create } = await run(
        [
          "create",
          "--name",
          "new-worker",
          "--env",
          "laptop",
          "--project",
          "project",
          "--title",
          "Worker",
          "--parent",
          parent,
          "--message",
          "work",
          "--no-notify",
        ],
        true,
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          parentThreadId: null,
          remoteParent: { environmentId: "local", threadId: rootId },
        }),
      );
      expect(JSON.parse(output)).toMatchObject({
        nesting: "remote",
        remoteParent: { environmentId: "local", threadId: rootId },
      });
    },
  );
  it("nests an existing remote worker and clears the remote link on unnest", async () => {
    const nested = await run(["nest", "worker", "--parent", "supervisor"], true);
    expect(JSON.parse(nested.output)).toMatchObject({
      parentThreadId: null,
      remoteParent: { environmentId: "local", threadId: rootId },
    });
    const unnested = await run(["unnest", "worker"], true);
    expect(unnested.setParent).toHaveBeenCalledWith(childId, null);
    expect(JSON.parse(unnested.output)).toMatchObject({ parentThreadId: null, remoteParent: null });
  });
  it("lists parent ids and available titles with state, settlement and pins from shells", async () => {
    const { output, detail } = await run(["threads", "--env", "local"]);
    expect(output).toContain(
      `${childId} [idle] Worker scope=null project settled=true pinned=true order=pinned:automatic parent=${rootId} (Supervisor)`,
    );
    expect(output).toContain(`parent=${childId} (Worker)`);
    expect(output).toContain("parent=none");
    expect(detail).not.toHaveBeenCalled();
  });
  it.each(["supervisor", rootId])("lists only direct children of %s", async (parent) => {
    const { output, detail } = await run(["threads", "--env", "local", "--parent", parent]);
    expect(output).toContain(childId);
    expect(output).not.toContain(grandchildId);
    expect(output).not.toContain("Other");
    expect(detail).not.toHaveBeenCalled();
  });
  it("lists every descendant when recursive, without unrelated threads or the root", async () => {
    const { output } = await run([
      "threads",
      "--env",
      "local",
      "--parent",
      "supervisor",
      "--recursive",
    ]);
    expect(output).toContain(childId);
    expect(output).toContain(grandchildId);
    expect(output).not.toContain(`${rootId} [idle]`);
    expect(output).not.toContain("Other");
  });
  it("includes nesting in the all-worker status list", async () => {
    const { output } = await run(["status"]);
    expect(output).toContain("parent=none");
    expect(output).toContain(`parent=${rootId}`);
  });
  it("shows a raw thread's parent id and title in status", async () => {
    const { output } = await run(["status", childId]);
    expect(JSON.parse(output)).toMatchObject({
      parentThreadId: rootId,
      parentTitle: "Supervisor",
      pinned: true,
    });
  });
  it("lists remote children without confusing a same-id local parent", () => {
    const remote = {
      ...shell(childId, null, "Remote"),
      remoteParent: { environmentId: "vm", threadId: rootId },
    };
    const local = shell("local-child", rootId, "Local");
    const grandchild = shell(grandchildId, childId, "Grandchild");
    expect(selectThreadChildren([remote, local, grandchild], rootId, false, "vm")).toEqual([
      remote,
    ]);
    expect(selectThreadChildren([remote, local, grandchild], rootId, true, "vm")).toEqual([
      remote,
      grandchild,
    ]);
  });
  it("terminates on malformed nesting cycles and excludes the requested root", () => {
    const cycle = [shell(rootId, childId, "Root"), shell(childId, rootId, "Child")];
    expect(selectThreadChildren(cycle, rootId, true).map((thread) => thread.id)).toEqual([childId]);
    expect(selectThreadChildren(cycle, "missing", true)).toEqual([]);
  });
});
