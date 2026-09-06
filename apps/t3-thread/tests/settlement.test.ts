import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import {
  ClientOrchestrationCommand,
  OrchestrationThread,
  OrchestrationThreadShell,
} from "../src/vendor/t3contracts/orchestration.js";
import { ClientOrchestrationCommand as ServerCommand } from "../../../packages/contracts/src/orchestration.js";
import type { SavedEnvironment } from "../src/types.js";

const encodeCommand = Schema.encodeUnknownSync(ClientOrchestrationCommand);
const decodeServerCommand = Schema.decodeUnknownSync(ServerCommand);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);
const decodeShell = Schema.decodeUnknownSync(OrchestrationThreadShell);

const threadId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-09T12:00:00.000Z";
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

const thread = {
  id: threadId,
  projectId: "project-1",
  title: "Test",
  modelSelection: { provider: "codex", model: "gpt-5.6-terra" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

function harness(settledOverride: "settled" | "active", failure?: Error) {
  const request = vi.fn(async (method: string, input: unknown) => {
    expect(method).toBe("dispatchCommand");
    const encoded = encodeCommand(input);
    const command = decodeServerCommand(encoded);
    expect(command).toMatchObject({
      type: settledOverride === "settled" ? "thread.settle" : "thread.unsettle",
      threadId,
      ...(settledOverride === "active" ? { reason: "user" } : {}),
    });
    if (failure) throw failure;
    return { sequence: 42 };
  });
  const subscribeThreadSnapshot = vi.fn(async (id: string) => {
    expect(id).toBe(threadId);
    expect(request).toHaveBeenCalledOnce();
    return {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 42,
        thread: decodeThread({
          ...thread,
          settledOverride,
          settledAt: settledOverride === "settled" ? timestamp : null,
          unsettledAt: settledOverride === "active" ? timestamp : null,
        }),
      },
    };
  });
  const dispose = vi.fn(async () => undefined);
  const rpcFactory = vi.fn(() => ({
    request,
    subscribeThreadSnapshot,
    dispose,
    subscribeShellSnapshot: vi.fn(async () => {
      throw new Error("Unexpected shell request");
    }),
  }));
  return {
    client: new RemoteEnvironmentClient(environment, { rpcFactory }),
    request,
    subscribeThreadSnapshot,
    dispose,
    rpcFactory,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("thread settlement", () => {
  it("dispatches settle through the real command codec and returns server timestamps", async () => {
    const h = harness("settled");
    expect(await h.client.settleThread(threadId)).toEqual({
      threadId,
      environment: "test",
      settledOverride: "settled",
      settledAt: timestamp,
      unsettledAt: null,
    });
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.dispose).toHaveBeenCalledTimes(2);
  });

  it("unsettles with reason user and reads back the active state without starting a turn", async () => {
    const h = harness("active");
    expect(await h.client.unsettleThread(threadId)).toEqual({
      threadId,
      environment: "test",
      settledOverride: "active",
      settledAt: null,
      unsettledAt: timestamp,
    });
    expect(h.request).toHaveBeenCalledOnce();
  });

  it("blocks self-settlement before opening a connection unless explicitly permitted", async () => {
    vi.stubEnv("T3_THREAD_ID", threadId);
    const h = harness("settled");
    await expect(h.client.settleThread(threadId)).rejects.toThrow("--self");
    expect(h.rpcFactory).not.toHaveBeenCalled();
    expect(await h.client.settleThread(threadId, { self: true })).toMatchObject({
      settledOverride: "settled",
    });
  });

  it("surfaces server rejection without returning a successful settlement", async () => {
    const h = harness("settled", new Error("Thread has active work"));
    await expect(h.client.settleThread(threadId)).rejects.toThrow("Thread has active work");
    expect(h.subscribeThreadSnapshot).not.toHaveBeenCalled();
    expect(h.dispose).toHaveBeenCalledOnce();
  });

  it("preserves lifecycle fields in shell snapshots and defaults older snapshots", () => {
    expect(
      decodeShell({
        ...thread,
        settledOverride: "active",
        settledAt: null,
        unsettledAt: timestamp,
      }),
    ).toMatchObject({ settledOverride: "active", settledAt: null, unsettledAt: timestamp });
    expect(decodeShell(thread)).toMatchObject({
      settledOverride: null,
      settledAt: null,
    });
    expect(decodeThread(thread)).toMatchObject({
      settledOverride: null,
      settledAt: null,
    });
  });
});
