import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { ClientOrchestrationCommand } from "../../../packages/contracts/src/orchestration.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { encodeClientOrchestrationCommand } from "../src/contracts.js";
import type { SavedEnvironment } from "../src/types.js";

const timestamp = "2026-10-01T00:00:00.000Z";
const environment: SavedEnvironment = {
  name: "test",
  httpBaseUrl: "http://127.0.0.1:1",
  wsBaseUrl: "ws://127.0.0.1:1",
  environmentId: "test",
  label: "test",
  serverVersion: "test",
  bearerToken: "test",
  expiresAt: timestamp,
  pairedAt: timestamp,
};
const threadId = "22222222-2222-4222-8222-222222222222";

function harness(supported: boolean) {
  let subproject: "auto" | "on" | "off" | undefined;
  const commands: (typeof ClientOrchestrationCommand.Type)[] = [];
  const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "serverGetConfig") return { providers: [], settings: DEFAULT_SERVER_SETTINGS };
    expect(method).toBe("dispatchCommand");
    const command = decode(encodeClientOrchestrationCommand(input));
    commands.push(command);
    if (command.type === "thread.subproject.set") subproject = command.mode;
    return { sequence: commands.length };
  });
  const rpcFactory = () => ({
    request,
    dispose: vi.fn(async () => undefined),
    subscribeShellSnapshot: vi.fn(async () => ({
      kind: "snapshot" as const,
      snapshot: { snapshotSequence: 0, projects: [], threads: [] },
    })),
    subscribeThreadSnapshot: vi.fn(async () => ({
      kind: "snapshot" as const,
      snapshot: {
        snapshotSequence: commands.length,
        thread: {
          id: threadId,
          parentThreadId: "parent",
          projectId: "project",
          title: "Worker",
          modelSelection: { provider: "codex", model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          archivedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
          session: null,
          ...(subproject ? { subproject } : {}),
        },
      },
    })),
  });
  const client = new RemoteEnvironmentClient(environment, { rpcFactory });
  vi.spyOn(client, "describe").mockResolvedValue({
    environmentId: "test",
    label: "test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: supported ? { threadSubprojects: true } : {},
  });
  return { client, commands };
}

describe("subproject marking", () => {
  it("dispatches thread.subproject.set for mark, unmark and auto and reads the mode back", async () => {
    const h = harness(true);
    expect(await h.client.setThreadSubproject(threadId, "on")).toMatchObject({
      threadId,
      subproject: "on",
    });
    expect(await h.client.setThreadSubproject(threadId, "off")).toMatchObject({
      subproject: "off",
    });
    expect(await h.client.setThreadSubproject(threadId, "auto")).toMatchObject({
      subproject: "auto",
    });
    expect(h.commands).toEqual([
      expect.objectContaining({ type: "thread.subproject.set", threadId, mode: "on" }),
      expect.objectContaining({ type: "thread.subproject.set", threadId, mode: "off" }),
      expect.objectContaining({ type: "thread.subproject.set", threadId, mode: "auto" }),
    ]);
  });

  it("refuses a server that does not advertise subprojects instead of dispatching", async () => {
    const h = harness(false);
    await expect(h.client.setThreadSubproject(threadId, "on")).rejects.toThrow(
      /without subprojects/,
    );
    expect(h.commands).toEqual([]);
  });
});
