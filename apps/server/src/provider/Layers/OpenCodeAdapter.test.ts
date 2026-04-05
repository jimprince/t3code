import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Stream } from "effect";
import { describe, it } from "@effect/vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeServerPool,
  type OpenCodeServerPoolShape,
} from "../Services/OpenCodeServerPool.ts";
import { OpenCodeAdapterLive } from "./OpenCodeAdapter.ts";

const asThreadId = (value: string) => ThreadId.makeUnsafe(value);

class AsyncEventStream<T> implements AsyncIterable<T> {
  private readonly values: Array<T> = [];
  private readonly resolvers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const resolver of this.resolvers.splice(0)) {
      resolver({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

class FakeOpenCodeClient {
  readonly createCalls: Array<unknown> = [];
  readonly getCalls: Array<unknown> = [];
  readonly messagesCalls: Array<unknown> = [];
  readonly messageCalls: Array<unknown> = [];
  readonly promptCalls: Array<unknown> = [];
  readonly abortCalls: Array<unknown> = [];
  readonly forkCalls: Array<unknown> = [];
  readonly permissionReplyCalls: Array<unknown> = [];
  readonly questionReplyCalls: Array<unknown> = [];

  readonly eventStream = new AsyncEventStream<any>();
  readonly messagesBySession = new Map<string, Array<any>>();
  readonly messageDetails = new Map<string, { parts: Array<any> }>();

  private readonly subscribed = Promise.withResolvers<void>();
  private createdSessionCount = 0;
  private forkedSessionCount = 0;

  session = {
    create: async (input: unknown) => {
      this.createCalls.push(input);
      this.createdSessionCount += 1;
      return {
        data: {
          id: `sess-created-${this.createdSessionCount}`,
          ...(typeof input === "object" && input !== null && "permission" in input
            ? { permission: (input as { permission?: unknown }).permission }
            : {}),
        },
      } as const;
    },
    get: async (input: { sessionID: string }) => {
      this.getCalls.push(input);
      return { data: { id: input.sessionID } } as const;
    },
    messages: async (input: { sessionID: string }) => {
      this.messagesCalls.push(input);
      return { data: this.messagesBySession.get(input.sessionID) ?? [] } as const;
    },
    message: async (input: { messageID: string }) => {
      this.messageCalls.push(input);
      return { data: this.messageDetails.get(input.messageID) ?? { parts: [] } } as const;
    },
    promptAsync: async (input: unknown) => {
      this.promptCalls.push(input);
      return {} as const;
    },
    abort: async (input: unknown) => {
      this.abortCalls.push(input);
      return {} as const;
    },
    fork: async (input: unknown) => {
      this.forkCalls.push(input);
      this.forkedSessionCount += 1;
      return { data: { id: `sess-forked-${this.forkedSessionCount}` } } as const;
    },
  };

  permission = {
    reply: async (input: unknown) => {
      this.permissionReplyCalls.push(input);
      return {} as const;
    },
  };

  question = {
    reply: async (input: unknown) => {
      this.questionReplyCalls.push(input);
      return {} as const;
    },
  };

  event = {
    subscribe: async (_input: unknown, options?: { signal?: AbortSignal }) => {
      options?.signal?.addEventListener("abort", () => this.eventStream.close(), { once: true });
      this.subscribed.resolve();
      return { stream: this.eventStream } as const;
    },
  };

  pushEvent(event: unknown): void {
    this.eventStream.push(event);
  }

  async waitForSubscription(): Promise<void> {
    await Promise.race([
      this.subscribed.promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Timed out waiting for OpenCode SSE subscription.")),
          1000,
        );
      }),
    ]);
  }
}

class OpenCodeAdapterHarness {
  readonly client = new FakeOpenCodeClient();
  readonly acquireCalls: Array<unknown> = [];
  readonly releaseCalls: Array<string> = [];

  readonly pool: OpenCodeServerPoolShape = {
    acquire: (input) => {
      this.acquireCalls.push(input);
      return Effect.succeed({
        key: "workspace:/repo",
        poolRoot: input.poolRoot ?? input.cwd,
        cwd: input.cwd,
        baseUrl: "http://127.0.0.1:9999",
        client: this.client as never,
        release: Effect.sync(() => {
          this.releaseCalls.push(input.cwd);
        }),
      });
    },
    loadProviderCatalog: () => Effect.die("unused"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  };
}

function makeLayer(
  harness: OpenCodeAdapterHarness,
  serverSettingsOverrides?: Parameters<typeof ServerSettingsService.layerTest>[0],
) {
  return OpenCodeAdapterLive.pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeServerPool, harness.pool)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest(serverSettingsOverrides)),
    Layer.provideMerge(NodeServices.layer),
  );
}

function collectRuntimeEvents(adapter: typeof OpenCodeAdapter.Service, count: number) {
  return Stream.runCollect(Stream.take(adapter.streamEvents, count)).pipe(
    Effect.map((events) => Array.from(events)),
  );
}

function drainRuntimeEvents(adapter: typeof OpenCodeAdapter.Service, count: number) {
  return collectRuntimeEvents(adapter, count).pipe(Effect.asVoid);
}

describe("OpenCodeAdapterLive", () => {
  it.effect("reuses resume cursors and honors the OpenCode binary override", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-resumed", []);
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-resume"),
        cwd: "/repo/worktree-a",
        providerOptions: {
          opencode: {
            binaryPath: "/opt/opencode/bin/opencode",
          },
        },
        resumeCursor: { sessionId: "sess-resumed" },
        runtimeMode: "full-access",
      });

      yield* Effect.promise(() => harness.client.waitForSubscription());
      const startupEvents = yield* collectRuntimeEvents(adapter, 3);

      assert.deepEqual(harness.acquireCalls[0], {
        cwd: "/repo/worktree-a",
        poolRoot: "/repo/worktree-a",
        binaryPath: "/opt/opencode/bin/opencode",
      });
      assert.deepEqual(harness.client.getCalls[0], { sessionID: "sess-resumed" });
      assert.equal(session.provider, "opencode");
      assert.deepEqual(session.resumeCursor, { sessionId: "sess-resumed" });
      assert.equal(startupEvents[0]?.type, "session.started");
      if (startupEvents[0]?.type === "session.started") {
        assert.equal(startupEvents[0].payload.message, "Recovered OpenCode session.");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "uses the configured OpenCode binary path when no per-session override is provided",
    () => {
      const harness = new OpenCodeAdapterHarness();
      return Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;

        yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-settings-binary"),
          cwd: "/repo/worktree-settings",
          runtimeMode: "full-access",
        });

        assert.deepEqual(harness.acquireCalls[0], {
          cwd: "/repo/worktree-settings",
          poolRoot: "/repo/worktree-settings",
          binaryPath: "/srv/opencode-custom",
        });
      }).pipe(
        Effect.provide(
          makeLayer(harness, {
            providers: {
              opencode: {
                binaryPath: "/srv/opencode-custom",
              },
            },
          }),
        ),
      );
    },
  );

  it.effect("hydrates resumed OpenCode runtime mode from live session permission rules", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-resumed-supervised", []);
      harness.client.session.get = async (input: { sessionID: string }) => {
        harness.client.getCalls.push(input);
        return {
          data: {
            id: input.sessionID,
            permission: [
              { permission: "*", pattern: "*", action: "allow" },
              { permission: "bash", pattern: "*", action: "ask" },
            ],
          },
        } as const;
      };
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-resume-supervised"),
        cwd: "/repo/worktree-b",
        resumeCursor: { sessionId: "sess-resumed-supervised" },
        runtimeMode: "full-access",
      });

      assert.equal(session.runtimeMode, "approval-required");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "starts a fresh session and reports a fresh start when the resume cursor is stale",
    () => {
      const harness = new OpenCodeAdapterHarness();
      return Effect.gen(function* () {
        harness.client.messagesBySession.set("sess-created-1", []);
        harness.client.session.get = async (input: { sessionID: string }) => {
          harness.client.getCalls.push(input);
          throw new Error("session not found");
        };
        const adapter = yield* OpenCodeAdapter;

        const session = yield* adapter.startSession({
          provider: "opencode",
          threadId: asThreadId("thread-stale-resume"),
          cwd: "/repo/worktree-stale",
          resumeCursor: { sessionId: "sess-stale" },
          runtimeMode: "full-access",
        });

        yield* Effect.promise(() => harness.client.waitForSubscription());
        const startupEvents = yield* collectRuntimeEvents(adapter, 3);

        assert.deepEqual(harness.client.getCalls[0], { sessionID: "sess-stale" });
        assert.equal(harness.client.createCalls.length, 1);
        assert.deepEqual(session.resumeCursor, { sessionId: "sess-created-1" });
        assert.equal(startupEvents[0]?.type, "session.started");
        if (startupEvents[0]?.type === "session.started") {
          assert.equal(startupEvents[0].payload.message, "Started OpenCode session.");
          assert.deepEqual(startupEvents[0].payload.resume, { sessionId: "sess-created-1" });
        }
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("maps plan turns into promptAsync inputs and canonical turn.started events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-send"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-send"),
        input: "Plan the refactor",
        modelSelection: {
          provider: "opencode",
          model: "anthropic/claude-sonnet-4.5",
        },
        interactionMode: "plan",
        attachments: [],
      });
      const [event] = yield* collectRuntimeEvents(adapter, 1);

      const promptCall = harness.client.promptCalls[0] as {
        sessionID: string;
        messageID: string;
        model: { providerID: string; modelID: string };
        agent: string;
        parts: Array<{ type: string; text?: string }>;
      };

      assert.equal(promptCall.sessionID, "sess-created-1");
      assert.deepEqual(promptCall.model, {
        providerID: "anthropic",
        modelID: "claude-sonnet-4.5",
      });
      assert.equal(promptCall.agent, "plan");
      assert.deepEqual(promptCall.parts, [{ type: "text", text: "Plan the refactor" }]);
      assert.equal(turn.turnId, `opencode:${promptCall.messageID}`);
      assert.equal(event?.type, "turn.started");
      if (event?.type === "turn.started") {
        assert.equal(event.payload.model, "anthropic/claude-sonnet-4.5");
      }
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps OpenCode permission requests into canonical approval events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-permission"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-permission"),
        input: "Run the check",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      harness.client.pushEvent({
        type: "permission.asked",
        properties: {
          sessionID: "sess-created-1",
          id: "perm-1",
          permission: "bash",
          patterns: ["git status"],
        },
      });
      const [opened] = yield* collectRuntimeEvents(adapter, 1);

      assert.equal(opened?.type, "request.opened");
      if (opened?.type === "request.opened") {
        assert.equal(opened.requestId, "perm-1");
        assert.equal(opened.payload.requestType, "command_execution_approval");
      }

      yield* adapter.respondToRequest(
        asThreadId("thread-permission"),
        ApprovalRequestId.makeUnsafe("perm-1"),
        "acceptForSession",
      );
      assert.deepEqual(harness.client.permissionReplyCalls[0], {
        requestID: "perm-1",
        reply: "always",
      });
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps OpenCode question flows into canonical user-input events", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-question"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-question"),
        input: "Need structured input",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      harness.client.pushEvent({
        type: "question.asked",
        properties: {
          sessionID: "sess-created-1",
          id: "question-1",
          questions: [
            {
              header: "scope",
              question: "What scope should I use?",
              options: [{ label: "repo", description: "Repository root" }],
            },
            {
              header: "mode",
              question: "Which mode should I use?",
              options: [{ label: "fast", description: "Fast path" }],
              multiple: true,
              custom: false,
            },
          ],
        },
      });
      const [requested] = yield* collectRuntimeEvents(adapter, 1);

      assert.equal(requested?.type, "user-input.requested");
      yield* adapter.respondToUserInput(
        asThreadId("thread-question"),
        ApprovalRequestId.makeUnsafe("question-1"),
        {
          scope: "repo",
          mode: ["fast", "careful"],
        },
      );
      assert.deepEqual(harness.client.questionReplyCalls[0], {
        requestID: "question-1",
        answers: [["repo"], ["fast", "careful"]],
      });
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("aborts the active OpenCode turn when interrupted by the user", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", []);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-interrupt"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const turn = yield* adapter.sendTurn({
        threadId: asThreadId("thread-interrupt"),
        input: "Interrupt this turn",
        attachments: [],
      });
      yield* drainRuntimeEvents(adapter, 1);

      yield* adapter.interruptTurn(asThreadId("thread-interrupt"));
      const [aborted] = yield* collectRuntimeEvents(adapter, 1);
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(harness.client.abortCalls[0], {
        sessionID: "sess-created-1",
      });
      assert.equal(aborted?.type, "turn.aborted");
      if (aborted?.type === "turn.aborted") {
        assert.equal(aborted.turnId, turn.turnId);
        assert.deepEqual(aborted.payload, {
          reason: "Turn interrupted by user.",
        });
      }
      assert.equal(sessions[0]?.status, "ready");
      assert.equal(sessions[0]?.activeTurnId, undefined);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("forks and rebinds the OpenCode session when rolling back", () => {
    const harness = new OpenCodeAdapterHarness();
    return Effect.gen(function* () {
      harness.client.messagesBySession.set("sess-created-1", [
        { info: { role: "user", id: "user-msg-1" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-1",
            parentID: "user-msg-1",
            time: { completed: new Date().toISOString() },
          },
        },
        { info: { role: "user", id: "user-msg-2" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-2",
            parentID: "user-msg-2",
            time: { completed: new Date().toISOString() },
          },
        },
      ]);
      harness.client.messagesBySession.set("sess-forked-1", [
        { info: { role: "user", id: "user-msg-1" } },
        {
          info: {
            role: "assistant",
            id: "assistant-msg-1",
            parentID: "user-msg-1",
            time: { completed: new Date().toISOString() },
          },
        },
      ]);
      const adapter = yield* OpenCodeAdapter;

      yield* adapter.startSession({
        provider: "opencode",
        threadId: asThreadId("thread-rollback"),
        cwd: "/repo",
        runtimeMode: "full-access",
      });
      yield* Effect.promise(() => harness.client.waitForSubscription());
      yield* drainRuntimeEvents(adapter, 3);

      const snapshot = yield* adapter.rollbackThread(asThreadId("thread-rollback"), 1);
      const sessions = yield* adapter.listSessions();

      assert.deepEqual(harness.client.forkCalls[0], {
        sessionID: "sess-created-1",
        messageID: "user-msg-2",
      });
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.id, "opencode:user-msg-1");
      assert.deepEqual(sessions[0]?.resumeCursor, { sessionId: "sess-forked-1" });
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});
