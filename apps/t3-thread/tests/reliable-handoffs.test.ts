import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentAuthorizationError, AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { SocketOpenError, SocketReadError } from "effect/unstable/socket/Socket";
import { drainQueuedSends } from "../src/sendQueue.js";
import { loadState, saveState } from "../src/state.js";
import { sendTransportCause } from "../src/sendIntents.js";
import { RemoteEnvironmentClient } from "../src/client.js";
import { descriptorFixture } from "./descriptor-fixture.js";
import type { SavedEnvironment } from "../src/types.js";

const environment = {
  name: "fixture",
  httpBaseUrl: "http://fixture.invalid",
  wsBaseUrl: "ws://fixture.invalid",
  environmentId: "fixture",
  label: "Fixture",
  serverVersion: "fixture",
  bearerToken: "fixture",
  expiresAt: "2099-01-01T00:00:00Z",
  pairedAt: "2026-10-07T00:00:00Z",
} satisfies SavedEnvironment;

// The production fixtures are private; CI and machines without them skip explicitly.
const fixtures = process.env.T3_LIFECYCLE_FIXTURES;

describe.skipIf(!fixtures)("reliable handoff transport", () => {
  beforeAll(async () => {
    await NodeFSP.stat(NodePath.join(fixtures!, "synthetic-edges.small.sanitized.sqlite"));
  });
  it("waits for durable fsync before the first transport request", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-fsync-"));
    const old = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
    const probe = await NodeFSP.open(NodePath.join(directory, "probe"), "w");
    const prototype = Object.getPrototypeOf(probe) as { sync: NodeFSP.FileHandle["sync"] };
    const sync = prototype.sync;
    await probe.close();
    let release!: () => void,
      syncEntered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(prototype, "sync").mockImplementation(async function (
      this: NodeFSP.FileHandle,
    ) {
      if ((await this.stat()).isFile()) {
        syncEntered = true;
        await gate;
      }
      await sync.call(this);
    });
    const request = vi.fn(async (_method: string, input: any) => ({
      sendId: input.sendId,
      recipientThreadId: input.recipientThreadId,
      status: "started",
      cause: null,
      acceptedAt: "2026-10-07T00:00:00Z",
      ownerThreadId: null,
    }));
    const client = new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => ({
        ...(await descriptorFixture(environment)()),
        capabilities: { reliableHandoffs: true },
      }),
      rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
    });
    let sending: ReturnType<typeof client.sendMessage> | undefined;
    try {
      sending = client.sendMessage({
        commandId: "fsync-gate",
        threadId: "recipient",
        text: "fixture",
      });
      await vi.waitFor(() => expect(syncEntered).toBe(true));
      expect(request).not.toHaveBeenCalled();
      release();
      expect(await sending).toMatchObject({ dispatched: true });
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await sending;
      spy.mockRestore();
      if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
      else process.env.T3_AGENT_STATE_FILE = old;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["TimeoutError", undefined, "TRANSPORT_TIMEOUT"],
    ["Error", "EIO", "TRANSPORT_OS_ERROR"],
    ["AbortError", undefined, "INTERRUPTED"],
  ])("keeps a dropped ack queryable and never retries %s", async (name, code, expected) => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-uncertain-"));
    const old = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
    let sendId = "";
    const request = vi.fn(async (_method: string, input: any) => {
      sendId = input.sendId;
      throw Object.assign(new Error("sensitive stderr and body sentinel"), { name, code });
    });
    const client = new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => ({
        ...(await descriptorFixture(environment)()),
        capabilities: { reliableHandoffs: true },
      }),
      rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
    });
    try {
      const outcome = await client.sendMessage({
        threadId: "recipient",
        text: "sensitive body sentinel",
      });
      expect(outcome).toMatchObject({
        dispatched: false,
        queued: false,
        uncertain: true,
        causeCode: expected,
        sendId,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(outcome)).not.toContain("sentinel");
      const stored = await NodeFSP.readFile(
        NodePath.join(directory, "send-intents", `${sendId}.json`),
        "utf8",
      );
      expect(stored).not.toContain("sentinel");
      expect(JSON.parse(stored).sendId).toBe(sendId);
    } finally {
      if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
      else process.env.T3_AGENT_STATE_FILE = old;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("never transports an intent that could not be persisted", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-disk-fail-"));
    const old = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
    await NodeFSP.writeFile(NodePath.join(directory, "send-intents"), "blocked");
    const request = vi.fn();
    const client = new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => ({
        ...(await descriptorFixture(environment)()),
        capabilities: { reliableHandoffs: true },
      }),
      rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
    });
    try {
      expect(await client.sendMessage({ threadId: "recipient", text: "body" })).toMatchObject({
        uncertain: false,
        causeCode: "PERSISTENCE_FAILED",
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
      else process.env.T3_AGENT_STATE_FILE = old;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("persists its identity before sending to a running recipient through server auto steering", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-"));
    const old = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
    const request = vi.fn(async (method: string, input: any) => {
      expect(method).toBe("fork.send.accept");
      const intents = JSON.parse(
        await NodeFSP.readFile(
          NodePath.join(directory, "send-intents", `${input.sendId}.json`),
          "utf8",
        ),
      );
      expect(intents.sendId).toBe(input.sendId);
      return {
        sendId: input.sendId,
        status: "steered",
        cause: null,
        acceptedAt: "2026-10-07T00:00:00Z",
        recipientThreadId: "recipient",
      };
    });
    const rpc = { request, dispose: vi.fn(async () => undefined) };
    const client = new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => ({
        ...(await descriptorFixture(environment)()),
        capabilities: { reliableHandoffs: true },
      }),
      rpcFactory: () => rpc as any,
    });
    vi.spyOn(client, "findThread").mockResolvedValue({
      id: "recipient",
      latestTurn: { state: "running", turnId: "run" },
      session: { status: "running" },
    } as any);
    try {
      const outcome = await client.sendMessage({ threadId: "recipient", text: "progress" });
      expect(request).toHaveBeenCalledTimes(1);
      expect(outcome).toMatchObject({
        dispatched: true,
        queued: false,
        receipt: { status: "steered" },
      });
    } finally {
      if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
      else process.env.T3_AGENT_STATE_FILE = old;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});

it("reads only the calling inbox and never hydrates another thread or sends", async () => {
  const old = process.env.T3_THREAD_ID;
  process.env.T3_THREAD_ID = "fixture-owner";
  const request = vi.fn(async (method: string, input: unknown) => {
    expect(method).toBe("fork.send.inbox");
    expect(input).toEqual({ threadId: "fixture-owner" });
    return { state: "unknown", receipts: [], retentionDays: 30, truncated: false };
  });
  const client = new RemoteEnvironmentClient(environment, {
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  const list = vi.spyOn(client, "listThreads"),
    read = vi.spyOn(client, "findThread");
  try {
    await client.ownSendInbox();
    expect(request).toHaveBeenCalledTimes(1);
    expect(list).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  } finally {
    if (old === undefined) delete process.env.T3_THREAD_ID;
    else process.env.T3_THREAD_ID = old;
  }
});

it("classifies production socket causes without leaking their sensitive messages", () => {
  expect(
    sendTransportCause(new SocketOpenError({ kind: "Timeout", cause: "private sentinel" })),
  ).toBe("TRANSPORT_TIMEOUT");
  expect(
    sendTransportCause(
      new SocketReadError({
        cause: Object.assign(new Error("private sentinel"), { code: "ECONNRESET" }),
      }),
    ),
  ).toBe("TRANSPORT_OS_ERROR");
});

it("releases a known held control handoff with the identical send policy after unsettle", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-held-policy-"));
  const old = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
  const inputs: any[] = [];
  const request = vi.fn(async (_method: string, input: any) => {
    inputs.push(input);
    if (inputs.length > 1) expect(input).toEqual(inputs[0]);
    return {
      sendId: input.sendId,
      recipientThreadId: input.recipientThreadId,
      status: inputs.length === 1 ? "held" : "started",
      cause: inputs.length === 1 ? "SETTLED" : null,
      acceptedAt: "2026-10-07T00:00:00Z",
      ownerThreadId: null,
    };
  });
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { reliableHandoffs: true },
    }),
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  vi.spyOn(client, "findThread").mockResolvedValue({
    id: "recipient",
    latestTurn: null,
    session: null,
    activities: [],
    messages: [],
    archivedAt: null,
    settledOverride: null,
  } as any);
  try {
    await saveState({
      version: 1,
      environments: [environment],
      agents: [],
      subscriptions: [],
      notifications: [],
      queuedSends: [],
    });
    expect(
      await client.sendMessage({
        commandId: "held-control",
        threadId: "recipient",
        text: "fixture",
        allowWhileRunning: true,
        queueWhileRunning: false,
      }),
    ).toMatchObject({ queued: true, receipt: { status: "held" } });
    await drainQueuedSends({ clientFactory: () => client });
    expect((await loadState()).queuedSends[0]?.status).toBe("dispatched");
    expect(request).toHaveBeenCalledTimes(2);
  } finally {
    if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = old;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it("returns a known sanitized cause for authenticated scope refusal without retry", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-scope-"));
  const old = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "routing.json");
  const request = vi.fn(async () => {
    throw new EnvironmentAuthorizationError({
      message: "private stderr/body sentinel",
      requiredScope: AuthOrchestrationOperateScope,
    });
  });
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { reliableHandoffs: true },
    }),
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  try {
    const result = await client.sendMessage({ threadId: "recipient", text: "fixture" });
    expect(result).toMatchObject({
      dispatched: false,
      queued: false,
      uncertain: false,
      causeCode: "ACCESS_DENIED",
    });
    expect(JSON.stringify(result)).not.toContain("sentinel");
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    if (old === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = old;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each([
  ["non-timeout socket open", new SocketOpenError({ kind: "Unknown", cause: "private sentinel" })],
  [
    "refused connect",
    Object.assign(new Error("private sentinel"), { code: "ECONNREFUSED", syscall: "connect" }),
  ],
  [
    "unreachable connect",
    Object.assign(new Error("private sentinel"), { code: "EHOSTUNREACH", syscall: "connect" }),
  ],
  [
    "DNS lookup",
    Object.assign(new Error("private sentinel"), { code: "ENOTFOUND", syscall: "getaddrinfo" }),
  ],
])("reports %s as retryable before admission", async (_label, error) => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "handoff-unsent-"));
  const previous = process.env.T3_AGENT_STATE_FILE;
  process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "state.json");
  const request = vi.fn(async () => {
    throw error;
  });
  const client = new RemoteEnvironmentClient(environment, {
    descriptorFactory: async () => ({
      ...(await descriptorFixture(environment)()),
      capabilities: { reliableHandoffs: true },
    }),
    rpcFactory: () => ({ request, dispose: async () => undefined }) as any,
  });
  try {
    expect(await client.sendMessage({ threadId: "recipient", text: "body" })).toMatchObject({
      dispatched: false,
      queued: false,
      uncertain: false,
      retryable: true,
    });
    expect(request).toHaveBeenCalledTimes(1);
  } finally {
    if (previous === undefined) delete process.env.T3_AGENT_STATE_FILE;
    else process.env.T3_AGENT_STATE_FILE = previous;
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});

it.each(["descriptor", "client/auth construction"])(
  "marks %s failure retryable before any acceptance frame",
  async (phase) => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "handoff-before-frame-"),
    );
    const previous = process.env.T3_AGENT_STATE_FILE;
    process.env.T3_AGENT_STATE_FILE = NodePath.join(directory, "state.json");
    const rpcFactory = vi.fn(() => {
      throw new Error("private sentinel");
    });
    const client = new RemoteEnvironmentClient(environment, {
      descriptorFactory: async () => {
        if (phase === "descriptor") throw new Error("private sentinel");
        return {
          ...(await descriptorFixture(environment)()),
          capabilities: { reliableHandoffs: true },
        };
      },
      rpcFactory,
    });
    try {
      const result = await client.sendMessage({ threadId: "recipient", text: "body" });
      expect(result).toMatchObject({
        dispatched: false,
        queued: false,
        uncertain: false,
        retryable: true,
      });
      expect(JSON.stringify(result)).not.toContain("sentinel");
      expect(rpcFactory).toHaveBeenCalledTimes(phase === "descriptor" ? 0 : 1);
    } finally {
      if (previous === undefined) delete process.env.T3_AGENT_STATE_FILE;
      else process.env.T3_AGENT_STATE_FILE = previous;
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  },
);
