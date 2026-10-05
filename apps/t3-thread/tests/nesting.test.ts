import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentClient } from "../src/client.js";
import { buildUserInputAnswers, findPendingRequests, resolveCreateParent } from "../src/nesting.js";
import { buildSubscriptionRecord, resolveNotifyPreference } from "../src/state.js";
import type { SavedEnvironment } from "../src/types.js";

const thread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  projectId: "project-1",
  parentThreadId: null,
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

const create = (overrides: Partial<Parameters<typeof resolveCreateParent>[0]> = {}) =>
  resolveCreateParent({
    explicitParentThreadId: null,
    topLevel: false,
    serverSupportsNesting: true,
    callerThreadId: "orchestrator",
    projectId: "project-1",
    threads: [thread("orchestrator")],
    ...overrides,
  });

describe("resolveCreateParent", () => {
  it("records a remote parent without putting a foreign id in the local link", () => {
    const remoteParent = { environmentId: "vm-id", threadId: "lead" };
    expect(create({ threads: [], remoteParent })).toEqual({
      parentThreadId: null,
      remoteParent,
      reason: "remote",
    });
    expect(create({ remoteParent, topLevel: true })).toEqual({
      parentThreadId: null,
      reason: "--top-level",
    });
  });
  it("nests a worker under the calling thread by default", () => {
    expect(create()).toEqual({ parentThreadId: "orchestrator", reason: "caller" });
  });

  it("keeps a worker top-level when asked or when there is no caller", () => {
    expect(create({ topLevel: true }).parentThreadId).toBeNull();
    expect(create({ callerThreadId: null }).parentThreadId).toBeNull();
  });

  it("reports top-level instead of claiming a nest on servers without nesting", () => {
    expect(create({ serverSupportsNesting: false })).toMatchObject({
      parentThreadId: null,
      reason: "this environment's server does not support nesting yet",
    });
  });

  it("honors an explicit parent over the caller", () => {
    expect(create({ explicitParentThreadId: "lead" })).toEqual({
      parentThreadId: "lead",
      reason: "explicit",
    });
  });

  it("nests across projects but stays top-level across environments", () => {
    expect(create({ projectId: "project-2" })).toMatchObject({
      parentThreadId: "orchestrator",
      reason: "caller",
    });
    expect(create({ threads: [] })).toMatchObject({
      parentThreadId: null,
      reason: "calling thread is in another environment",
    });
  });

  it("nests under the caller when the caller is itself nested", () => {
    const threads = [thread("lead"), thread("orchestrator", { parentThreadId: "lead" })];
    expect(create({ threads })).toEqual({ parentThreadId: "orchestrator", reason: "caller" });
  });

  it("keeps nesting and notification ownership on the direct caller at every depth", () => {
    const threads = [thread("root"), thread("caller", { parentThreadId: "root" })];
    const nesting = create({ callerThreadId: "caller", threads });
    const notify = resolveNotifyPreference(undefined, {
      T3_THREAD_ID: "caller",
    } as NodeJS.ProcessEnv);
    const route = buildSubscriptionRecord(
      { threadId: "caller", name: "caller", environment: "dev-vm" },
      { threadId: "grandchild", name: "grandchild", environment: "dev-vm" },
      "2026-10-02T00:00:00.000Z",
    );

    expect(nesting).toEqual({ parentThreadId: "caller", reason: "caller" });
    expect(notify).toEqual({ kind: "caller" });
    expect(route).toMatchObject({
      subscriberThreadId: "caller",
      sourceThreadId: "grandchild",
    });
  });
});

const activity = (kind: string, payload: Record<string, unknown>, createdAt = "2026-01-01") => ({
  kind,
  createdAt,
  payload,
});

describe("findPendingRequests", () => {
  it("lists open questions and approvals oldest first and drops resolved or stale ones", () => {
    const pending = findPendingRequests([
      activity("approval.requested", { requestId: "a1", detail: "rm -rf build" }, "2026-01-02"),
      activity(
        "user-input.requested",
        { requestId: "q1", questions: [{ id: "color", question: "Which color?", options: [] }] },
        "2026-01-01",
      ),
      activity("approval.requested", { requestId: "a2" }),
      activity("approval.resolved", { requestId: "a2" }),
      activity("user-input.requested", {
        requestId: "q2",
        questions: [{ id: "x", question: "Stale?" }],
      }),
      activity("provider.user-input.respond.failed", {
        requestId: "q2",
        detail: "Stale pending user-input request",
      }),
    ]);
    expect(pending.map((request) => request.requestId)).toEqual(["q1", "a1"]);
  });
});

describe("buildUserInputAnswers", () => {
  const one = [{ id: "color", question: "Which color?", options: [] }];
  const two = [...one, { id: "size", question: "Which size?", options: [] }];

  it("uses free text for a single question", () => {
    expect(buildUserInputAnswers({ questions: one, text: "blue", pairs: [] })).toEqual({
      color: "blue",
    });
  });

  it("requires an answer for every question when there are several", () => {
    expect(() => buildUserInputAnswers({ questions: two, text: "blue", pairs: [] })).toThrow(
      "Answer every question",
    );
    expect(
      buildUserInputAnswers({ questions: two, text: "", pairs: ["color=blue", "size=large"] }),
    ).toEqual({ color: "blue", size: "large" });
  });

  it("rejects an unknown question id", () => {
    expect(() =>
      buildUserInputAnswers({ questions: one, text: "", pairs: ["shape=round"] }),
    ).toThrow("Unknown question id");
  });
});

describe("RemoteEnvironmentClient.supportsThreadNesting", () => {
  const environment: SavedEnvironment = {
    name: "test",
    httpBaseUrl: "http://127.0.0.1:1",
    wsBaseUrl: "ws://127.0.0.1:1",
    environmentId: "test",
    label: "test",
    serverVersion: "test",
    bearerToken: "test",
    expiresAt: "2026-09-25T00:00:00.000Z",
    pairedAt: "2026-09-25T00:00:00.000Z",
  };
  // Server config as the CLI reads it has no environment block; checking it
  // kept every create top-level on servers that support nesting.
  const rpcFactory = (): never => {
    throw new Error("the capability check must not need an RPC");
  };
  const serveDescriptor = (capabilities: Record<string, boolean>) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        expect(url).toBe("http://127.0.0.1:1/.well-known/t3/environment");
        return new Response(
          JSON.stringify({
            environmentId: "test",
            label: "test",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "test",
            capabilities,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the capability from the environment descriptor", async () => {
    serveDescriptor({ threadNesting: true });
    const client = new RemoteEnvironmentClient(environment, { rpcFactory });
    await expect(client.supportsThreadNesting()).resolves.toBe(true);
  });

  it("refuses remote creation and nesting on older servers before dispatch", async () => {
    serveDescriptor({ threadNesting: true });
    const client = new RemoteEnvironmentClient(environment, { rpcFactory });
    const remoteParent = { environmentId: "vm", threadId: "parent" };
    await expect(
      client.createAgentThread({
        projectId: "project",
        title: "Worker",
        initialMessage: "work",
        remoteParent,
      }),
    ).rejects.toThrow("Update the child server");
    await expect(client.setThreadParent("worker", null, remoteParent)).rejects.toThrow(
      "Update the child server",
    );
  });

  it("reports no nesting when the descriptor does not advertise it", async () => {
    serveDescriptor({});
    const client = new RemoteEnvironmentClient(environment, { rpcFactory });
    await expect(client.supportsThreadNesting()).resolves.toBe(false);
  });
});
