import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  RuntimeItemId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";

const asProjectId = (value: string): ProjectId => ProjectId.makeUnsafe(value);
const asSessionId = (value: string): ProviderSessionId => ProviderSessionId.makeUnsafe(value);
const asProviderThreadId = (value: string): ProviderThreadId =>
  ProviderThreadId.makeUnsafe(value);
const asRuntimeSessionId = (value: string): RuntimeSessionId => RuntimeSessionId.makeUnsafe(value);
const asTurnId = (value: string): TurnId => TurnId.makeUnsafe(value);
const asRuntimeItemId = (value: string): RuntimeItemId => RuntimeItemId.makeUnsafe(value);
const asEventId = (value: string): EventId => EventId.makeUnsafe(value);
const asMessageId = (value: string): MessageId => MessageId.makeUnsafe(value);

function createProviderServiceHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions: () => Effect.succeed([]),
    rollbackConversation: () => unsupported(),
    stopAll: () => Effect.void,
    streamEvents: Stream.fromPubSub(runtimeEventPubSub),
  };

  const emit = (event: ProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
  };

  return {
    service,
    emit,
  };
}

async function waitForThread(
  engine: OrchestrationEngineShape,
  predicate: (thread: {
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
    activities: ReadonlyArray<{ kind: string }>;
  }) => boolean,
  timeoutMs = 2000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<{
    session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
    messages: ReadonlyArray<{ id: string; text: string; streaming: boolean }>;
    activities: ReadonlyArray<{ kind: string }>;
  }> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for thread state");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("ProviderRuntimeIngestion", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | ProviderRuntimeIngestionService,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness() {
    const provider = createProviderServiceHarness();
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
    );
    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start.pipe(Scope.provide(scope)));
    await Effect.runPromise(Effect.sleep("10 millis"));

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.makeUnsafe("cmd-provider-project-create"),
        projectId: asProjectId("project-1"),
        title: "Provider Project",
        workspaceRoot: "/tmp/provider-project",
        defaultModel: "gpt-5-codex",
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.makeUnsafe("cmd-thread-create"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Thread",
        model: "gpt-5-codex",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "codex",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-1"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          updatedAt: createdAt,
          lastError: null,
        },
        createdAt,
      }),
    );

    return {
      engine,
      emit: provider.emit,
    };
  }

  it("maps turn started/completed events into thread session updates", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-1"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "running" && thread.session?.activeTurnId === "turn-1",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-1"),
      payload: { state: "failed", errorMessage: "turn failed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === null &&
        entry.session?.lastError === "turn failed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("turn failed");
  });

  it("does not clear active turn when session/thread started arrives mid-turn", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-midturn-lifecycle",
    );

    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      payload: { providerThreadId: asProviderThreadId("provider-thread-1") },
    });
    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started-midturn-lifecycle"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      payload: {},
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-midturn-lifecycle");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-midturn-lifecycle"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      turnId: asTurnId("turn-midturn-lifecycle"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores auxiliary turn completions from a different provider thread", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-primary"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      turnId: asTurnId("turn-primary"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-primary",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-aux"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-aux"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-primary");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-primary"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      turnId: asTurnId("turn-primary"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("accepts claude turn lifecycle when seeded thread id is a synthetic placeholder", async () => {
    const harness = await createHarness();
    const seededAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.makeUnsafe("cmd-session-seed-claude-placeholder"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        session: {
          threadId: ThreadId.makeUnsafe("thread-1"),
          status: "ready",
          providerName: "claudeCode",
          providerSessionId: asSessionId("sess-1"),
          providerThreadId: asProviderThreadId("claude-thread-placeholder"),
          approvalPolicy: "on-request",
          sandboxMode: "workspace-write",
          activeTurnId: null,
          updatedAt: seededAt,
          lastError: null,
        },
        createdAt: seededAt,
      }),
    );

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-claude-placeholder"),
      provider: "claudeCode",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-real"),
      turnId: asTurnId("turn-claude-placeholder"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-claude-placeholder",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-claude-placeholder"),
      provider: "claudeCode",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      threadId: ThreadId.makeUnsafe("provider-thread-real"),
      turnId: asTurnId("turn-claude-placeholder"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("ignores non-active turn completion when runtime omits thread id", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-guarded"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-guarded-main"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-guarded-main",
    );

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-other"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-guarded-other"),
      payload: { state: "completed" },
    });

    await Effect.runPromise(Effect.sleep("40 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.session?.status).toBe("running");
    expect(midThread?.session?.activeTurnId).toBe("turn-guarded-main");

    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-guarded-main"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-guarded-main"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) => thread.session?.status === "ready" && thread.session?.activeTurnId === null,
    );
  });

  it("maps message delta/completed into finalized assistant messages", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-1"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-2"),
      itemId: asRuntimeItemId("item-1"),
      payload: { streamKind: "assistant_text", delta: "hello" },
    });
    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-2"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-2"),
      itemId: asRuntimeItemId("item-1"),
      payload: { streamKind: "assistant_text", delta: " world" },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-2"),
      itemId: asRuntimeItemId("item-1"),
      payload: { itemType: "assistant_message" },
    });

    const thread = await waitForThread(harness.engine, (entry) =>
      entry.messages.some((message) => message.id === "assistant:item-1" && !message.streaming),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-1");
    expect(message?.text).toBe("hello world");
    expect(message?.streaming).toBe(false);
  });

  it("buffers assistant deltas by default until completion", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffered"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffered"),
      payload: {},
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" && thread.session?.activeTurnId === "turn-buffered",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffered"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffered"),
      itemId: asRuntimeItemId("item-buffered"),
      payload: { streamKind: "assistant_text", delta: "buffer me" },
    });

    await Effect.runPromise(Effect.sleep("30 millis"));
    const midReadModel = await Effect.runPromise(harness.engine.getReadModel());
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.makeUnsafe("thread-1"));
    expect(midThread?.messages.some((message) => message.id === "assistant:item-buffered")).toBe(
      false,
    );

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffered"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffered"),
      itemId: asRuntimeItemId("item-buffered"),
      payload: { itemType: "assistant_message" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.some((message) => message.id === "assistant:item-buffered" && !message.streaming),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-buffered");
    expect(message?.text).toBe("buffer me");
    expect(message?.streaming).toBe(false);
  });

  it("streams assistant deltas when thread.turn.start requests streaming mode", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe("cmd-turn-start-streaming-mode"),
        threadId: ThreadId.makeUnsafe("thread-1"),
        message: {
          messageId: asMessageId("message-streaming-mode"),
          role: "user",
          text: "stream please",
          attachments: [],
        },
        assistantDeliveryMode: "streaming",
        approvalPolicy: "on-request",
        sandboxMode: "workspace-write",
        createdAt: now,
      }),
    );
    await Effect.runPromise(Effect.sleep("30 millis"));

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-streaming-mode"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-streaming-mode"),
      payload: {},
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-streaming-mode",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-streaming-mode"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asRuntimeItemId("item-streaming-mode"),
      payload: { streamKind: "assistant_text", delta: "hello live" },
    });

    const liveThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.some(
          (message) =>
            message.id === "assistant:item-streaming-mode" &&
            message.streaming &&
            message.text === "hello live",
        ),
    );
    const liveMessage = liveThread.messages.find(
      (entry) => entry.id === "assistant:item-streaming-mode",
    );
    expect(liveMessage?.streaming).toBe(true);

    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-streaming-mode"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-streaming-mode"),
      itemId: asRuntimeItemId("item-streaming-mode"),
      payload: { itemType: "assistant_message" },
    });

    const finalThread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.some(
          (message) => message.id === "assistant:item-streaming-mode" && !message.streaming,
        ),
    );
    const finalMessage = finalThread.messages.find(
      (entry) => entry.id === "assistant:item-streaming-mode",
    );
    expect(finalMessage?.text).toBe("hello live");
    expect(finalMessage?.streaming).toBe(false);
  });

  it("spills oversized buffered deltas and still finalizes full assistant text", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();
    const oversizedText = "x".repeat(40_000);

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-buffer-spill"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffer-spill"),
      payload: {},
    });
    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-buffer-spill",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-buffer-spill"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asRuntimeItemId("item-buffer-spill"),
      payload: { streamKind: "assistant_text", delta: oversizedText },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-buffer-spill"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-buffer-spill"),
      itemId: asRuntimeItemId("item-buffer-spill"),
      payload: { itemType: "assistant_message" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.messages.some(
          (message) => message.id === "assistant:item-buffer-spill" && !message.streaming,
        ),
    );
    const message = thread.messages.find((entry) => entry.id === "assistant:item-buffer-spill");
    expect(message?.text.length).toBe(oversizedText.length);
    expect(message?.text).toBe(oversizedText);
    expect(message?.streaming).toBe(false);
  });

  it("does not duplicate assistant completion when message.completed is followed by turn.completed", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "turn.started",
      eventId: asEventId("evt-turn-started-for-complete-dedup"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-complete-dedup"),
      payload: {},
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "running" &&
        thread.session?.activeTurnId === "turn-complete-dedup",
    );

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-message-delta-for-complete-dedup"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asRuntimeItemId("item-complete-dedup"),
      payload: { streamKind: "assistant_text", delta: "done" },
    });
    harness.emit({
      type: "item.completed",
      eventId: asEventId("evt-message-completed-for-complete-dedup"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-complete-dedup"),
      itemId: asRuntimeItemId("item-complete-dedup"),
      payload: { itemType: "assistant_message" },
    });
    harness.emit({
      type: "turn.completed",
      eventId: asEventId("evt-turn-completed-for-complete-dedup"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-complete-dedup"),
      payload: { state: "completed" },
    });

    await waitForThread(
      harness.engine,
      (thread) =>
        thread.session?.status === "ready" &&
        thread.session?.activeTurnId === null &&
        thread.messages.some(
          (message) => message.id === "assistant:item-complete-dedup" && !message.streaming,
        ),
    );

    const events = await Effect.runPromise(
      Stream.runCollect(harness.engine.readEvents(0)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      ),
    );
    const completionEvents = events.filter((event) => {
      if (event.type !== "thread.message-sent") {
        return false;
      }
      return (
        event.payload.messageId === "assistant:item-complete-dedup" &&
        event.payload.streaming === false
      );
    });
    expect(completionEvents).toHaveLength(1);
  });

  it("maps runtime.error into errored session state", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-3"),
      payload: { message: "runtime exploded" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-3" &&
        entry.session?.lastError === "runtime exploded",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime exploded");
  });

  it("maps session/thread lifecycle and tool.started into session/activity projections", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "session.started",
      eventId: asEventId("evt-session-started"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      threadId: ThreadId.makeUnsafe("provider-thread-1"),
      payload: { message: "session started" },
    });
    harness.emit({
      type: "thread.started",
      eventId: asEventId("evt-thread-started"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      threadId: ThreadId.makeUnsafe("provider-thread-2"),
      payload: { providerThreadId: ProviderThreadId.makeUnsafe("provider-thread-2") },
    });
    harness.emit({
      type: "item.started",
      eventId: asEventId("evt-tool-started"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-9"),
      payload: {
        itemType: "command_execution",
        status: "inProgress",
        title: "Read file",
        detail: "/tmp/file.ts",
      },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "ready" &&
        entry.session?.activeTurnId === null &&
        entry.activities.some((activity) => activity.kind === "tool.started"),
    );

    expect(thread.session?.status).toBe("ready");
    expect(thread.activities.some((activity) => activity.kind === "tool.started")).toBe(true);
  });

  it("continues processing runtime events after a single event handler failure", async () => {
    const harness = await createHarness();
    const now = new Date().toISOString();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-invalid-delta"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: now,
      turnId: asTurnId("turn-invalid"),
      itemId: asRuntimeItemId("item-invalid"),
      payload: { streamKind: "assistant_text", delta: undefined },
    } as unknown as ProviderRuntimeEvent);

    harness.emit({
      type: "runtime.error",
      eventId: asEventId("evt-runtime-error-after-failure"),
      provider: "codex",
      sessionId: asRuntimeSessionId("sess-1"),
      createdAt: new Date().toISOString(),
      turnId: asTurnId("turn-after-failure"),
      payload: { message: "runtime still processed" },
    });

    const thread = await waitForThread(
      harness.engine,
      (entry) =>
        entry.session?.status === "error" &&
        entry.session?.activeTurnId === "turn-after-failure" &&
        entry.session?.lastError === "runtime still processed",
    );
    expect(thread.session?.status).toBe("error");
    expect(thread.session?.lastError).toBe("runtime still processed");
  });
});
