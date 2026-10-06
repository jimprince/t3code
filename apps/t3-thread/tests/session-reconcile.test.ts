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
const base = {
  id: "22222222-2222-4222-8222-222222222222",
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
};

function harness() {
  const commands: (typeof ClientOrchestrationCommand.Type)[] = [];
  const decode = Schema.decodeUnknownSync(ClientOrchestrationCommand);
  const request = vi.fn(async (method: string, input: unknown) => {
    if (method === "serverGetConfig") return { providers: [], settings: DEFAULT_SERVER_SETTINGS };
    expect(method).toBe("dispatchCommand");
    commands.push(decode(encodeClientOrchestrationCommand(input)));
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
      snapshot: { snapshotSequence: 0, thread: base },
    })),
  });
  return { client: new RemoteEnvironmentClient(environment, { rpcFactory }), commands };
}

describe("session reconcile", () => {
  it("asks the server to recompute the thread's session from its latest turn", async () => {
    const h = harness();
    await h.client.reconcileSession(base.id);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toMatchObject({
      type: "thread.session.reconcile",
      threadId: base.id,
    });
  });
});
