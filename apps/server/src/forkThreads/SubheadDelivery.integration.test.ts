import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NamedAgentName,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { expect } from "vite-plus/test";
import { layerMemory } from "../persistence/Sqlite.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Adapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { layerWithRegistry } from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { AutomationStore, layer as storeLayer } from "../automations/AutomationStore.ts";
import { makeSubheadDelivery } from "./SubheadDelivery.ts";
import { writeMetadata } from "./MetadataStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6.1-sol" };
const projectId = ProjectId.make("project");
const sender = ThreadId.make("sender");
const execution = ThreadId.make("execution");
const now = "2026-10-15T00:00:00.000Z";
const runtime = layerWithRegistry(
  { name: "virtual-result" },
  Adapters.layerFromAdapters([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("Result delivery tests never execute a provider"),
    },
  ]),
  { databaseLayer: layerMemory, runEffectWorker: false },
);
const layer = Layer.mergeAll(Threads.layer.pipe(Layer.provideMerge(runtime)), storeLayer).pipe(
  Layer.provideMerge(layerMemory),
);
const createThread = (id: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* Threads.ThreadManagementService;
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create-${id}`),
      threadId: id,
      projectId,
      title: "Sender",
      modelSelection,
      createdBy: "user",
      creationSource: "server",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
  });
const createSender = createThread(sender);
const nativeInput = (id: string) =>
  Effect.gen(function* () {
    const threads = yield* Threads.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: execution,
      messageId: MessageId.make(id),
      text: "Work",
      attachments: [],
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
    return (yield* threads.getThreadRecords(execution, ["runs"])).runs.find(
      (run) => run.userMessageId === id,
    )!;
  });
const terminal = (
  run: OrchestrationV2Run,
  status: "completed" | "failed" | "interrupted" | "cancelled",
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* (yield* EventSink.EventSinkV2).write({
      events: [
        {
          id: EventId.make(`terminal-${run.id}`),
          type: "run.updated",
          threadId: execution,
          occurredAt: now,
          payload: { ...run, status, completedAt: now },
        },
      ],
    });
  });
function completedRun(recipient: ThreadId | null = sender) {
  return {
    id: "subhead:run",
    automationId: "subhead:helper",
    projectId,
    name: "review",
    dedupeKey: "request-key",
    trigger: { kind: "manual" as const },
    ownerThreadId: ThreadId.make("head"),
    dryRun: false,
    status: "completed" as const,
    result: "One useful finding",
    createdAt: now,
    finishedAt: now,
    steps: [
      {
        kind: "agent" as const,
        status: "completed" as const,
        target: { kind: "new-thread" as const },
        threadId: execution,
        messageId: MessageId.make("request-message"),
        title: "Review",
        prompt: "Review",
        result: "One useful finding",
        startedAt: now,
        finishedAt: now,
      },
    ],
    virtualSubhead: {
      agentId: "helper",
      environmentId: "environment",
      templateHash: "template-hash",
      senderPrincipal: "thread:sender",
      senderThreadId: recipient,
      requestId: "request",
      request: "Review",
      requestHash: "hash",
      blockedReason: null,
      leaseStartedAt: null,
      terminationReason: null,
      template: {
        id: "helper",
        name: NamedAgentName.make("review"),
        kind: "virtual" as const,
        projectId,
        ownerThreadId: ThreadId.make("head"),
        description: "Review",
        prompt: "Review",
        modelSelection,
        runtimeMode: "full-access" as const,
        concurrency: 1,
        version: 1,
        enabled: true,
        retiredAt: null,
        createdAt: now,
        updatedAt: now,
      },
      delivery: {
        id: "subhead-result:subhead:run",
        status: "pending" as const,
        messageId: null,
        attempts: 0,
        error: null,
      },
    },
  };
}

it.layer(NodeServices.layer)("durable virtual results", (it) => {
  for (const status of ["completed", "failed", "interrupted", "cancelled"] as const) {
    it.effect(`captures and safely settles a ${status} execution`, () =>
      Effect.gen(function* () {
        yield* createSender;
        yield* createThread(execution);
        const run = completedRun(null);
        yield* writeMetadata(yield* SqlClient.SqlClient, {
          threadId: execution,
          parentThreadId: sender,
          virtualAgentId: "helper",
          virtualRunId: run.id,
        });
        yield* terminal(yield* nativeInput(run.steps[0]!.messageId), status);
        yield* (yield* AutomationStore).insertRun({
          ...run,
          status: status === "completed" ? "completed" : "failed",
        });
        const delivery = yield* makeSubheadDelivery(Effect.succeed([]));
        expect((yield* delivery.deliver(run.id)).result).toBe("One useful finding");
        expect(
          (yield* (yield* Threads.ThreadManagementService).getThreadShell(execution))
            ?.settledOverride,
        ).toBe("settled");
      }).pipe(Effect.provide(layer)),
    );
  }
  it.effect("never settles an intervening user run when capturing an older helper result", () =>
    Effect.gen(function* () {
      yield* createSender;
      yield* createThread(execution);
      const run = completedRun(null);
      yield* writeMetadata(yield* SqlClient.SqlClient, {
        threadId: execution,
        parentThreadId: sender,
        virtualAgentId: "helper",
        virtualRunId: run.id,
      });
      yield* terminal(yield* nativeInput(run.steps[0]!.messageId), "completed");
      yield* terminal(yield* nativeInput("intervening"), "completed");
      yield* (yield* AutomationStore).insertRun(run);
      yield* (yield* makeSubheadDelivery(Effect.succeed([]))).deliver(run.id);
      expect(
        (yield* (yield* Threads.ThreadManagementService).getThreadShell(execution))
          ?.settledOverride,
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
  it.effect("appends one useful result and survives losing the post-dispatch delivery write", () =>
    Effect.gen(function* () {
      yield* createSender;
      const store = yield* AutomationStore;
      const run = completedRun();
      yield* store.insertRun(run);
      const delivery = yield* makeSubheadDelivery(Effect.succeed([]));
      yield* delivery.deliver(run.id);
      // Equivalent to crashing after native dispatch committed but before marking delivery.
      yield* store.saveRun(run);
      yield* delivery.deliver(run.id);
      yield* delivery.deliver(run.id);
      const records = yield* (yield* Threads.ThreadManagementService).getThreadRecords(sender, [
        "messages",
      ]);
      const results = records.messages.filter((message) => message.text.includes("subhead_result"));
      expect(results).toHaveLength(1);
      expect(results[0]?.text).toContain("One useful finding");
      expect(Option.getOrThrow(yield* store.getRun(run.id)).virtualSubhead?.delivery.status).toBe(
        "delivered",
      );
    }).pipe(Effect.provide(layer)),
  );
  it.effect(
    "holds a settled recipient, then delivers once to that same recipient after resume",
    () =>
      Effect.gen(function* () {
        yield* createSender;
        const threads = yield* Threads.ThreadManagementService;
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId: sender,
        });
        const store = yield* AutomationStore;
        const run = completedRun();
        yield* store.insertRun(run);
        const delivery = yield* makeSubheadDelivery(Effect.succeed([]));
        expect((yield* delivery.deliver(run.id)).virtualSubhead?.delivery.status).toBe("held");
        expect((yield* threads.getThreadRecords(sender, ["messages"])).messages).toHaveLength(0);
        yield* threads.dispatch({
          type: "thread.unsettle",
          commandId: CommandId.make("resume"),
          threadId: sender,
          reason: "user",
        });
        yield* delivery.deliver(run.id);
        yield* delivery.deliver(run.id);
        expect((yield* threads.getThreadRecords(sender, ["messages"])).messages).toHaveLength(1);
      }).pipe(Effect.provide(layer)),
  );
  it.effect("retains undeliverable and pull-only results without rerouting", () =>
    Effect.gen(function* () {
      const store = yield* AutomationStore;
      const delivery = yield* makeSubheadDelivery(Effect.succeed([]));
      const missing = completedRun(ThreadId.make("missing"));
      yield* store.insertRun(missing);
      expect((yield* delivery.deliver(missing.id)).virtualSubhead?.delivery.status).toBe(
        "undelivered",
      );
      const pull = { ...completedRun(null), id: "subhead:pull", dedupeKey: "pull" };
      yield* store.insertRun(pull);
      const captured = yield* delivery.deliver(pull.id);
      expect(captured.result).toBe("One useful finding");
      expect(captured.virtualSubhead?.delivery.status).toBe("pull-only");
    }).pipe(Effect.provide(layer)),
  );
});
