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
const childId = "thread:delegated-task:command%3Amcp%3Aworker";
const grandchildId = "automation:scheduled:grandchild";
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
const originalExitCode = process.exitCode;
afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});
async function run(args: string[]) {
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
      ...(!args.includes(childId)
        ? [
            {
              name: "worker",
              environment: "local",
              threadId: childId,
              projectId: "project",
              title: "Worker",
              createdAt: timestamp,
              lastSeenAssistantMessageId: null,
            },
          ]
        : []),
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
  const parent = vi
    .spyOn(RemoteEnvironmentClient.prototype, "setThreadParent")
    .mockResolvedValue({ threadId: childId as never, parentThreadId: rootId as never });
  const settle = vi.spyOn(RemoteEnvironmentClient.prototype, "settleThread").mockResolvedValue({
    threadId: childId,
    environment: "local",
    settledOverride: "settled",
    settledAt: timestamp,
    unsettledAt: null,
  });
  const rename = vi
    .spyOn(RemoteEnvironmentClient.prototype, "renameThread")
    .mockResolvedValue({ threadId: childId, title: "Changed", scope: null });
  const result = vi
    .spyOn(RemoteEnvironmentClient.prototype, "getThreadDetail")
    .mockImplementation(async (id) => ({
      ...threads.find((thread) => thread.id === id)!,
      messages: [],
      activities: [],
      checkpoints: [],
      proposedPlans: [],
    }));
  let finish!: (value: string) => void;
  let reject!: (error: Error) => void;
  const printed = new Promise<string>((resolve, fail) => {
    finish = resolve;
    reject = fail;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    reject(new Error(String(chunk)));
    return true;
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    finish(String(chunk));
    return true;
  });
  process.argv = [process.execPath, "cli.ts", ...args];
  await import("../src/cli.js");
  return { output: await printed, list, detail, parent, settle, rename, result };
}

describe("CLI nesting readback", () => {
  it("lists parent ids and available titles with state, settlement and pins from shells", async () => {
    const { output, detail } = await run(["threads", "--env", "local"]);
    expect(output).toContain(
      `${childId} [idle] Worker project settled=true pinned=true parent=${rootId} (Supervisor)`,
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
  it("terminates on malformed nesting cycles and excludes the requested root", () => {
    const cycle = [shell(rootId, childId, "Root"), shell(childId, rootId, "Child")];
    expect(selectThreadChildren(cycle, rootId, true).map((thread) => thread.id)).toEqual([childId]);
    expect(selectThreadChildren(cycle, "missing", true)).toEqual([]);
  });
});

it.each([
  ["nest", ["--parent", rootId]],
  ["unnest", []],
  ["settle", []],
  ["rename", ["--title", "Changed"]],
  ["result", []],
] as const)(
  "CLI %s accepts an unsaved delegated thread ID with embedded percent escapes",
  async (command, options) => {
    const seen = await run([command, childId, ...options]);
    expect(seen.output).toContain(childId);
    if (command === "nest" || command === "unnest")
      expect(seen.parent).toHaveBeenCalledWith(childId, command === "nest" ? rootId : null, null);
    if (command === "settle")
      expect(seen.settle).toHaveBeenCalledWith(childId, { self: undefined });
    if (command === "rename")
      expect(seen.rename).toHaveBeenCalledWith({ threadId: childId, title: "Changed" });
    if (command === "result") expect(seen.result).toHaveBeenCalledWith(childId);
  },
);
