import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import type * as Scope from "effect/Scope";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  MessageId,
  RunId,
  EventId,
  TurnItemId,
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2TurnItem,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Locks from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as RecoveryStore from "./RecoveryStore.ts";
import * as Reset from "./SessionResetService.ts";
import * as Pending from "./PendingHumanRequests.ts";
import * as Handover from "./HandoverService.ts";
import { RecoveryAuthority } from "./RecoveryAuthority.ts";

export const database = SqlitePersistenceMemory;
const stores = Layer.mergeAll(ProjectionStore.layer, EventStore.layer, RecoveryStore.layer).pipe(
  Layer.provideMerge(database),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadRecords: (threadId, fields, filter) =>
        projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
    });
  }),
).pipe(Layer.provide(stores));
const pending = Pending.layer.pipe(Layer.provide(Layer.mergeAll(stores, IdAllocator.layer)));
const baseConfig = ServerConfig.layerTest(process.cwd(), { prefix: "recovery-test-" });
export const config = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.map(ServerConfig.ServerConfig, (c) => ({ ...c, devUrl: new URL("http://127.0.0.1:1") })),
).pipe(Layer.provide(baseConfig));
const dependencies = Layer.mergeAll(
  stores,
  sink,
  management,
  pending,
  Locks.layer,
  config,
  IdAllocator.layer,
);
const layer = Layer.mergeAll(
  dependencies,
  Reset.layer.pipe(Layer.provide(dependencies)),
  Handover.layer.pipe(Layer.provide(dependencies)),
).pipe(Layer.provideMerge(NodeServices.layer));
const admin = {
  principal: "operator-test",
  scopes: [AuthAccessWriteScope, AuthOrchestrationOperateScope],
};
const now = DateTime.makeUnsafe("2026-10-10T00:00:00Z");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const old = ThreadId.make("old"),
  successor = ThreadId.make("successor"),
  sibling = ThreadId.make("sibling");
const runId = RunId.make("run-old"),
  sessionId = ProviderSessionId.make("session-old"),
  ptId = ProviderThreadId.make("pt-old");
const messageId = MessageId.make("human-old"),
  itemId = TurnItemId.make("item-human-old");
const thread = (id: ThreadId): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("project"),
  title: id,
  providerInstanceId: model.instanceId,
  modelSelection: model,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  deletedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  createdBy: "user",
  creationSource: "web",
});
const run = (status: OrchestrationV2Run["status"]): OrchestrationV2Run => ({
  id: runId,
  threadId: old,
  ordinal: 1,
  providerInstanceId: model.instanceId,
  modelSelection: model,
  providerThreadId: ptId,
  userMessageId: messageId,
  rootNodeId: null,
  activeAttemptId: null,
  status,
  requestedAt: now,
  startedAt: now,
  completedAt: status === "completed" ? now : null,
  checkpointId: null,
  contextHandoffId: null,
});
const message = (id = messageId): OrchestrationV2ConversationMessage => ({
  id,
  threadId: old,
  runId,
  nodeId: null,
  role: "user",
  text: `Human request ${id}`,
  attachments: [],
  streaming: false,
  createdAt: now,
  updatedAt: now,
  createdBy: "user",
  creationSource: "web",
});
const item: OrchestrationV2TurnItem = {
  id: itemId,
  threadId: old,
  runId,
  nodeId: null,
  providerThreadId: ptId,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 100,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "user_message",
  messageId,
  inputIntent: "turn_start",
  text: "Human request",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
};
const providerThread: OrchestrationV2ProviderThread = {
  id: ptId,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: model.instanceId,
  providerSessionId: sessionId,
  appThreadId: old,
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "native-old",
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
};
const write = (events: readonly OrchestrationV2DomainEvent[]) =>
  EventSink.EventSinkV2.use((s) => s.write({ events }));
let sequence = 0;
type DraftEvent<E = OrchestrationV2DomainEvent> = E extends OrchestrationV2DomainEvent
  ? Omit<E, "id" | "occurredAt">
  : never;
const event = <E extends DraftEvent>(event: E) => ({
  ...event,
  id: EventId.make(`test-event-${++sequence}`),
  occurredAt: now,
});
const seed = (status: OrchestrationV2Run["status"] = "running") =>
  write([
    event({
      type: "thread.created",
      threadId: old,
      payload: { ...thread(old), pinnedAt: now, pinOrderKey: "a0", activeOrderKey: "a1" },
    }),
    event({ type: "thread.created", threadId: successor, payload: thread(successor) }),
    event({ type: "thread.created", threadId: sibling, payload: thread(sibling) }),
    event({ type: "run.created", threadId: old, payload: run(status) }),
    event({ type: "message.updated", threadId: old, payload: message() }),
    event({ type: "turn-item.updated", threadId: old, payload: item }),
    event({ type: "provider-thread.updated", threadId: old, payload: providerThread }),
    event({
      type: "provider-session.attached",
      threadId: old,
      payload: {
        id: sessionId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: model.instanceId,
        status: "running",
        cwd: "/tmp",
        model: "test",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      },
    }),
  ]);
/**
 * Appends numbered web turns to `seed()`'s thread; each completed turn has an assistant reply.
 * Turns listed in `statuses` take that run status and get no reply.
 */
const seedConversation = (
  turns: number,
  statuses: Readonly<Record<number, OrchestrationV2Run["status"]>> = {},
) =>
  write(
    Array.from({ length: turns }, (_, index) => {
      const turn = index + 1;
      // seed() owns run ordinal 1.
      const ordinal = turn + 1;
      const status = statuses[turn] ?? "completed";
      const turnRunId = RunId.make(`run-${turn}`);
      const userMessageId = MessageId.make(`human-${turn}`);
      return [
        event({
          type: "run.created",
          threadId: old,
          payload: { ...run(status), id: turnRunId, ordinal, userMessageId },
        }),
        event({
          type: "message.updated",
          threadId: old,
          payload: { ...message(userMessageId), runId: turnRunId },
        }),
        event({
          type: "turn-item.updated",
          threadId: old,
          payload: {
            ...item,
            id: TurnItemId.make(`item-human-${turn}`),
            runId: turnRunId,
            ordinal: ordinal * 10,
            messageId: userMessageId,
            text: `Human request ${userMessageId}`,
          },
        }),
        ...(status === "completed"
          ? [
              event({
                type: "message.updated",
                threadId: old,
                payload: {
                  ...message(MessageId.make(`assistant-${turn}`)),
                  runId: turnRunId,
                  role: "assistant" as const,
                  createdBy: "agent" as const,
                  creationSource: "provider" as const,
                  text: `Answer ${turn}`,
                },
              }),
            ]
          : []),
      ];
    }).flat(),
  );
const input = {
  threadId: old,
  runId,
  expectedGeneration: 0,
  requestId: "reset-1",
  reason: "watchdog_force" as const,
};
const execute = <A, E>(
  effect: Effect.Effect<A, E, RecoveryAuthority | Layer.Success<typeof layer> | Scope.Scope>,
) =>
  Effect.scoped(
    effect.pipe(Effect.provideService(RecoveryAuthority, admin), Effect.provide(layer)),
  );

export {
  stores,
  layer,
  admin,
  old,
  successor,
  sibling,
  sessionId,
  messageId,
  itemId,
  thread,
  run,
  message,
  write,
  event,
  seed,
  seedConversation,
  execute,
  input,
};
