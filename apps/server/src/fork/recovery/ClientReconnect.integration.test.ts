import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { layerMemory as SqlitePersistenceMemory } from "../../persistence/Sqlite.ts";
import { layer as OrchestrationEventStoreLive } from "../../persistence/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "../../persistence/OrchestrationEventStore.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import { subscribeOrchestrationV2Thread } from "../../ws.ts";

it.live.each([undefined, 999])(
  "retains the persisted event between snapshot and live subscription (cursor %s)",
  (afterSequence) => {
    const persistence = SqlitePersistenceMemory;
    const store = OrchestrationEventStoreLive.pipe(Layer.provideMerge(persistence));
    return Effect.gen(function* () {
      const events = yield* OrchestrationEventStore;
      const now = yield* DateTime.now;
      const id = ThreadId.make("client-reconnect");
      const thread: OrchestrationV2AppThread = {
        id,
        projectId: ProjectId.make("reconnect-project"),
        title: "before snapshot",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const projection = {
        thread,
        runs: [],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: [],
        updatedAt: now,
      } as unknown as OrchestrationV2ThreadProjection;
      yield* events.appendAgentEvents({
        events: [
          {
            id: EventId.make("created"),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      const snapshot = () =>
        Effect.gen(function* () {
          const snapshotSequence = yield* events.latestAgentSequence(id);
          const late = yield* events.appendAgentEvents({
            events: [
              {
                id: EventId.make("late-during-snapshot"),
                type: "thread.metadata-updated",
                threadId: id,
                occurredAt: now,
                payload: { ...thread, title: "late update" },
              },
            ],
          });
          yield* events.publishCommitted(late);
          return { schemaVersion: 1, snapshotSequence, projection };
        }).pipe(Effect.orDie);
      const management = Layer.mock(ThreadManagement.ThreadManagementService)({
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshot: snapshot,
        getThreadSnapshotWindow: snapshot,
        streamStoredEventsFrom: (input) =>
          events
            .streamApplicationEvents(
              input?.afterSequence === undefined ? {} : { afterSequence: input.afterSequence },
            )
            .pipe(
              Stream.filter((row): row is OrchestrationV2StoredEvent => "event" in row),
              Stream.orDie,
            ),
      });
      const items = yield* subscribeOrchestrationV2Thread({
        threadId: id,
        ...(afterSequence === undefined ? {} : { afterSequence }),
        acceptBoundedSnapshot: true,
        requestCompletionMarker: true,
      }).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(3), Stream.runCollect)),
        Effect.provide(management),
      );
      expect(items.map((item) => item.kind)).toEqual(["snapshot", "synchronized", "event"]);
      expect(items[0]).toMatchObject({
        snapshotSequence: 1,
        projection: { thread: { title: "before snapshot" } },
      });
      expect(items[2]).toMatchObject({
        sequence: 2,
        event: { payload: { title: "late update" } },
      });
    }).pipe(Effect.scoped, Effect.provide(store));
  },
);
