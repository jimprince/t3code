import { describe, expect, it, vi } from "vite-plus/test";
import { Schema } from "effect";
import {
  OrchestrationV2Command,
  OrchestrationV2ThreadLaunchInput,
  ForkThreadMetadataUpdate,
} from "@t3tools/contracts";
import { RemoteEnvironmentClient } from "../src/client.js";
import type { SavedEnvironment } from "../src/types.js";
const environment: SavedEnvironment = {
  name: "test",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
  environmentId: "descriptor",
  label: "Test",
  serverVersion: "test",
  bearerToken: "test",
  expiresAt: "2099-01-01T00:00:00.000Z",
  pairedAt: "2026-10-02T00:00:00.000Z",
};
const decodeMetadataUpdate = Schema.decodeUnknownSync(ForkThreadMetadataUpdate);
const decodeLaunch = Schema.decodeUnknownSync(OrchestrationV2ThreadLaunchInput);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);
function harness() {
  let title = "Original";
  let scope: string | null = null;
  let parentThreadId: string | null = null;
  const commands: string[] = [];
  const operations: string[] = [];
  const launches: Array<typeof OrchestrationV2ThreadLaunchInput.Type> = [];
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      environmentId: environment.environmentId,
      label: environment.label,
      platform: { os: "linux", arch: "x64" },
      serverVersion: "test",
      capabilities: { threadNesting: true },
    }),
    rpcFactory: () => ({
      request: async <T>(method: string, input: unknown): Promise<T> => {
        if (method === "threadMetadataList")
          return [{ threadId: "thread", parentThreadId, scope }] as T;
        if (method === "threadMetadataUpdate") {
          operations.push("nest");
          const value = decodeMetadataUpdate(input);
          if (value.scope !== undefined) scope = value.scope;
          if (value.parentThreadId !== undefined) parentThreadId = value.parentThreadId;
          return value as T;
        }
        if (method === "launchThread") {
          const value = decodeLaunch(input);
          launches.push(value);
          operations.push(value.initialMessage ? "start" : "claim");
          return { threadId: value.threadId } as T;
        }
        const command = decodeCommand(input);
        commands.push(command.type);
        if (command.type === "thread.metadata.update" && command.title) title = command.title;
        return { sequence: commands.length } as T;
      },
      subscribeShellSnapshot: async <T>(): Promise<T> =>
        ({
          kind: "snapshot",
          snapshot: {
            projects: [
              {
                id: "project",
                title: "Project",
                workspaceRoot: "/workspace",
                defaultModelSelection: { provider: "codex", model: "gpt-6.1-sol" },
              },
            ],
            threads: [],
          },
        }) as T,
      subscribeThreadSnapshot: async <T>(): Promise<T> =>
        ({
          kind: "snapshot",
          snapshot: { thread: { id: "thread", title, projectId: "project" } },
        }) as T,
      dispose: async () => {},
    }),
  });
  vi.spyOn(client, "getServerConfig").mockRejectedValue(new Error("model inventory unavailable"));
  return { client, commands, launches, operations };
}
describe("V2 worker titles", () => {
  it("persists supervision before the first provider message", async () => {
    const h = harness();
    await h.client.createAgentThread({
      projectId: "project",
      title: "Chosen",
      initialMessage: "Work",
      parentThreadId: "parent",
    });
    expect(h.operations).toEqual(["claim", "nest", "start"]);
    expect(h.launches[0]?.initialMessage).toBeUndefined();
    expect(h.launches[1]).toMatchObject({
      reuseExistingThread: true,
      generateTitle: false,
      initialMessage: { text: "Work" },
    });
  });
  it("renames and clears server scope with verified reads without launching a provider", async () => {
    const h = harness();
    expect(
      await h.client.renameThread({ threadId: "thread", title: "Manual", scope: "Repo A" }),
    ).toEqual({ threadId: "thread", title: "Manual", scope: "Repo A" });
    expect((await h.client.renameThread({ threadId: "thread", scope: null })).scope).toBeNull();
    expect(h.commands).toEqual(["thread.metadata.update"]);
    expect(h.launches).toHaveLength(0);
  });
  it("explicit creation opts out of native title generation", async () => {
    const h = harness();
    await h.client.createAgentThread({
      projectId: "project",
      title: "Chosen",
      initialMessage: "Work",
      workerContext: {
        name: "worker",
        parent: { threadId: "parent", name: "supervisor", environment: "other", title: "Owner" },
        notifyLevel: "all",
      },
    });
    expect(h.launches[0]).toMatchObject({ title: "Chosen", generateTitle: false });
    expect(h.launches[1]?.initialMessage?.text).toContain(
      'parent_send_command: "t3-thread send supervisor ..."',
    );
    expect(h.launches[1]?.initialMessage?.text).toContain('parent_environment: "other"');
  });
  it("nest and unnest read the organizational parent instead of execution lineage", async () => {
    const h = harness();
    await h.client.setThreadParent("thread", "parent");
    expect((await h.client.findThread("thread")).parentThreadId).toBe("parent");
    await h.client.setThreadParent("thread", null);
    expect((await h.client.findThread("thread")).parentThreadId).toBeNull();
  });
});
