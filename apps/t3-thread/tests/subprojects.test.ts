import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import { ThreadMetadataUpdate } from "../src/v2/nesting.js";
import { RemoteEnvironmentClient } from "../src/client.js";

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
  const commands: (typeof ThreadMetadataUpdate.Type)[] = [];
  const decode = Schema.decodeUnknownSync(ThreadMetadataUpdate);
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "serverGetConfig") return { providers: [], settings: DEFAULT_SERVER_SETTINGS };
    expect(method).toBe("threadMetadataUpdate");
    const command = decode(input);
    commands.push(command);
    subproject = command.subproject ?? undefined;
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
  vi.spyOn(client, "findThread").mockImplementation(
    async () => ({ id: threadId, subproject }) as never,
  );
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
  it("updates fork metadata for mark, unmark and auto and reads the mode back", async () => {
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
      expect.objectContaining({ threadId, subproject: "on" }),
      expect.objectContaining({ threadId, subproject: "off" }),
      expect.objectContaining({ threadId, subproject: "auto" }),
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
