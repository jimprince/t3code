import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { StateFile } from "../src/types.js";

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
const threadId = "22222222-2222-4222-8222-222222222222";
const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("rename command", () => {
  it.each([
    { args: ["rename", "worker"], saved: true },
    { args: ["agent", "rename", threadId], saved: true },
    { args: ["rename", threadId], saved: false },
  ])("renames by saved alias or own UUID through %j", async ({ args, saved }) => {
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
          pairedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      agents: ["worker", "other-alias"].map((name) => ({
        name,
        environment: "local",
        threadId,
        projectId: "project-1",
        title: "Original",
        createdAt: "2026-10-02T00:00:00.000Z",
        lastSeenAssistantMessageId: null,
      })),
      subscriptions: [],
      notifications: [],
      queuedSends: [],
    };
    vi.stubEnv("T3_THREAD_ID", threadId);
    vi.resetModules();
    const { RemoteEnvironmentClient } = await import("../src/client.js");
    if (!saved) {
      fixture.state.agents = [];
      vi.spyOn(RemoteEnvironmentClient.prototype, "listThreads").mockResolvedValue([
        {
          id: threadId,
          projectId: "project-1",
          title: "Original",
          modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          session: null,
          createdAt: "2026-10-02T00:00:00.000Z",
          updatedAt: "2026-10-02T00:00:00.000Z",
          archivedAt: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
        },
      ]);
    }
    const rename = vi
      .spyOn(RemoteEnvironmentClient.prototype, "renameThread")
      .mockResolvedValue({ threadId, title: "Supervisor A", scope: null });
    let finish!: (value: string) => void;
    const printed = new Promise<string>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      finish(String(chunk));
      return true;
    });
    process.argv = [process.execPath, "cli.ts", ...args, "--title", "Supervisor A"];
    await import("../src/cli.js");
    const output = JSON.parse(await printed);
    expect(rename).toHaveBeenCalledWith({ threadId, title: "Supervisor A" });
    expect(output).toMatchObject({
      threadId,
      title: "Supervisor A",
      renamed: true,
      scopeUpdated: false,
    });
    expect(fixture.state.agents.map((agent) => agent.title)).toEqual(
      saved ? ["Supervisor A", "Supervisor A"] : [],
    );
  });

  it("updates scope without changing saved titles", async () => {
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
          pairedAt: "2026-10-02T00:00:00.000Z",
        },
      ],
      agents: [
        {
          name: "worker",
          environment: "local",
          threadId,
          projectId: "project-1",
          title: "Original",
          createdAt: "2026-10-02T00:00:00.000Z",
          lastSeenAssistantMessageId: null,
        },
      ],
      subscriptions: [],
      notifications: [],
      queuedSends: [],
    };
    vi.resetModules();
    const { RemoteEnvironmentClient } = await import("../src/client.js");
    const rename = vi.spyOn(RemoteEnvironmentClient.prototype, "renameThread").mockResolvedValue({
      threadId,
      title: "Original",
      scope: "Coordinates the entire repo",
    });
    let finish!: (value: string) => void;
    const printed = new Promise<string>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      finish(String(chunk));
      return true;
    });
    process.argv = [
      process.execPath,
      "cli.ts",
      "rename",
      "worker",
      "--scope",
      "Coordinates the entire repo",
    ];
    await import("../src/cli.js");
    expect(rename).toHaveBeenCalledWith({
      threadId,
      scope: "Coordinates the entire repo",
    });
    expect(JSON.parse(await printed)).toMatchObject({
      threadId,
      scope: "Coordinates the entire repo",
      renamed: false,
      scopeUpdated: true,
    });
    expect(fixture.state.agents[0]?.title).toBe("Original");
  });
});
