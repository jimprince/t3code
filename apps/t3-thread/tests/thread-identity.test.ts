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
describe("worker bootstrap identity", () => {
  it.each([true, false])("bootstraps a real thread identity (nested=%s)", async (nested) => {
    const h = harness();
    const parent = nested
      ? { threadId, name: "supervisor", title: "Supervisor", environment: "test" }
      : null;
    const created = await h.client.createAgentThread({
      projectId: "project-1",
      title: "Worker",
      initialMessage: "Do the task",
      parentThreadId: parent?.threadId,
      workerContext: { name: "worker", parent, notifyLevel: "attention" },
    });
    const command = h.commands[0]!;
    expect(command.type).toBe("thread.turn.start");
    if (command.type !== "thread.turn.start") throw new Error("missing turn");
    expect(command.message.text).toContain(`thread_id: "${created.threadId}"`);
    expect(command.message.text).toContain('saved_name: "worker"');
    expect(command.message.text).toContain('environment: "test"');
    expect(command.message.text).toContain('project_id: "project-1"');
    expect(command.message.text).toContain('project_title: "Project"');
    expect(command.message.text).toContain('worktree_path: "/tmp/project"');
    expect(command.message.text).toContain(`parent_thread_id: "${nested ? threadId : "none"}"`);
    expect(command.message.text).toContain(
      `parent_send_command: "${nested ? "t3-thread send supervisor ..." : "none"}"`,
    );
    expect(command.message.text).toContain('notify_level: "attention"');
    expect(command.message.text).toContain(`date_utc: "${new Date().toISOString().slice(0, 10)}"`);
    expect(command.message.text.endsWith("--- BRIEF ---\nDo the task")).toBe(true);
  });
});
