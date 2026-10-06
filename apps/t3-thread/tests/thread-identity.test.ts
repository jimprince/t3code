import { descriptorFixture } from "./descriptor-fixture.js";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { OrchestrationV2ThreadLaunchInput } from "../../../packages/contracts/src/orchestrationV2.ts";
import { RemoteEnvironmentClient } from "../src/client.js";

import type { SavedEnvironment } from "../src/types.js";

const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
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
  const commands: Array<typeof OrchestrationV2ThreadLaunchInput.Type> = [];
  const dispose = vi.fn(async () => {});
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: descriptorFixture(environment),
    rpcFactory: () => ({
      request: async (_method, input) => {
        if (_method === "threadMetadataList") return [];
        if (_method === "threadMetadataUpdate") return input;
        const command = decodeCommand(input);
        commands.push(command);
        if (false) {
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

      workerContext: { name: "worker", parent, notifyLevel: "attention" },
    });
    expect(h.commands[0]?.initialMessage).toBeUndefined();
    const command = h.commands[1]!;
    expect(command.reuseExistingThread).toBe(true);
    expect(command.threadId).toBe(created.threadId);
    if (!command.initialMessage) throw new Error("missing initial message");
    expect(command.initialMessage.text).toContain(`thread_id: "${created.threadId}"`);
    expect(command.initialMessage.text).toContain('saved_name: "worker"');
    expect(command.initialMessage.text).toContain('environment: "test"');
    expect(command.initialMessage.text).toContain('project_id: "project-1"');
    expect(command.initialMessage.text).toContain('project_title: "Project"');
    expect(command.initialMessage.text).toContain('worktree_path: "/tmp/project"');
    expect(command.initialMessage.text).toContain(
      `parent_thread_id: "${nested ? threadId : "none"}"`,
    );
    expect(command.initialMessage.text).toContain(
      `parent_send_command: "${nested ? "t3-thread send supervisor ..." : "none"}"`,
    );
    expect(command.initialMessage.text).toContain('notify_level: "attention"');
    expect(command.initialMessage.text).toContain(
      `date_utc: "${new Date().toISOString().slice(0, 10)}"`,
    );
    expect(command.initialMessage.text.endsWith("--- BRIEF ---\nDo the task")).toBe(true);
  });
});
