import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ClientOrchestrationCommand } from "../../../packages/contracts/src/orchestration.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { encodeClientOrchestrationCommand } from "../src/contracts.js";
import type { SavedEnvironment } from "../src/types.js";

const decodeCommand = Schema.decodeUnknownSync(ClientOrchestrationCommand);
const threadId = "22222222-2222-4222-8222-222222222222";
const environment: SavedEnvironment = {
  name: "test",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
  environmentId: "test",
  label: "Test",
  serverVersion: "test",
  bearerToken: "test",
  expiresAt: "2099-01-01T00:00:00.000Z",
  pairedAt: "2026-10-02T00:00:00.000Z",
};
function harness(failRename = false) {
  let title = "Original";
  let scope: string | null = null;
  const commands: Array<typeof ClientOrchestrationCommand.Type> = [];
  const dispose = vi.fn(async () => {});
  const client = new RemoteEnvironmentClient(environment, {
    rpcFactory: () => ({
      request: async (_method, input) => {
        const command = decodeCommand(encodeClientOrchestrationCommand(input));
        commands.push(command);
        if (command.type === "thread.meta.update" && command.title) {
          if (failRename) throw new Error("rename rejected");
          title = command.title;
        }
        if (command.type === "thread.meta.update" && command.scope !== undefined) {
          scope = command.scope;
        }
        return { sequence: commands.length };
      },
      subscribeShellSnapshot: async () => ({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: commands.length,
          updatedAt: "2026-10-02T00:00:00.000Z",
          projects: [{ id: "project-1", title: "Project", workspaceRoot: "/tmp/project" }],
          threads: [],
        },
      }),
      subscribeThreadSnapshot: async () => ({
        kind: "snapshot",
        snapshot: {
          snapshotSequence: commands.length,
          thread: {
            id: threadId,
            projectId: "project-1",
            title,
            scope,
            modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            latestTurn: null,
            createdAt: "2026-10-02T00:00:00.000Z",
            updatedAt: "2026-10-02T00:00:00.000Z",
            archivedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            proposedPlans: [],
            session: null,
          },
        },
      }),
      dispose,
    }),
  });
  // Model inventory is unrelated to title ownership and unavailable in this RPC fixture.
  vi.spyOn(client, "getServerConfig").mockRejectedValue(new Error("offline model inventory"));
  return { client, commands, dispose };
}
afterEach(() => vi.unstubAllEnvs());
describe("operator thread titles", () => {
  it("renames the calling thread through the server and verifies its title", async () => {
    vi.stubEnv("T3_THREAD_ID", threadId);
    const h = harness();
    expect(await h.client.renameThread({ threadId, title: " Supervisor A " })).toEqual({
      threadId,
      title: "Supervisor A",
      scope: null,
    });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      type: "thread.meta.update",
      threadId,
      title: "Supervisor A",
    });
  });
  it("sets and clears project scope through the same metadata command", async () => {
    const h = harness();
    await expect(
      h.client.renameThread({ threadId, scope: " Coordinates the entire repo " }),
    ).resolves.toEqual({ threadId, title: "Original", scope: "Coordinates the entire repo" });
    await expect(h.client.renameThread({ threadId, scope: null })).resolves.toEqual({
      threadId,
      title: "Original",
      scope: null,
    });
    expect(h.commands).toMatchObject([
      { type: "thread.meta.update", threadId, scope: "Coordinates the entire repo" },
      { type: "thread.meta.update", threadId, scope: null },
    ]);
  });
  it("requires at least one metadata change", async () => {
    const h = harness();
    await expect(h.client.renameThread({ threadId })).rejects.toThrow(
      "Thread title or scope must be provided",
    );
    expect(h.commands).toEqual([]);
  });
  it.each(["", "   "])("rejects empty title %j before dispatch", async (title) => {
    const h = harness();
    await expect(h.client.renameThread({ threadId, title })).rejects.toThrow("must not be empty");
    expect(h.commands).toEqual([]);
  });
  it("does not claim a rename succeeded after server rejection", async () => {
    const h = harness(true);
    await expect(h.client.renameThread({ threadId, title: "Supervisor A" })).rejects.toThrow(
      "rename rejected",
    );
    expect(h.dispose).toHaveBeenCalledOnce();
  });
  it("persists explicit title intent before starting the first message and keeps native worktree preparation", async () => {
    const h = harness();
    const created = await h.client.createAgentThread({
      projectId: "project-1",
      title: "Supervisor A",
      initialMessage: "Resume Printcell Supervision",
      parentThreadId: threadId,
      branch: "t3/supervisor",
    });
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      type: "thread.turn.start",
      threadId: created.threadId,
      bootstrap: {
        createThread: { title: "Supervisor A", lockTitle: true, parentThreadId: threadId },
        prepareWorktree: { branch: "t3/supervisor" },
      },
      message: { text: "Resume Printcell Supervision" },
    });
  });
  it("does not create a thread with an empty explicit title", async () => {
    const h = harness();
    await expect(
      h.client.createAgentThread({
        projectId: "project-1",
        title: "  ",
        initialMessage: "Resume supervision",
      }),
    ).rejects.toThrow("must not be empty");
    expect(h.commands).toEqual([]);
  });
});
