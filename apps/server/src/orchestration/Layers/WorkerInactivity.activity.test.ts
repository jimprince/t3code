import {
  EventId,
  ProviderDriverKind,
  RuntimeTaskId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { observeInactivity } from "../../../../t3-thread/src/inactivity.ts";
import type { OrchestrationThread, SavedSubscription } from "../../../../t3-thread/src/types.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { runtimeEventToActivities } from "./ProviderRuntimeIngestion.ts";

const layer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-inactivity-projection-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);
const at = (minute: number) => `2026-10-02T12:${String(minute).padStart(2, "0")}:00.000Z`;

layer("worker inactivity from persisted provider progress", (it) => {
  for (const kind of ["task.progress", "tool.updated"] as const) {
    it.effect(`rearms from ${kind} snapshot timestamps when activity ids repeat`, () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make(`worker-${kind}`);
        const turnId = TurnId.make(`turn-${kind}`);
        const sql = yield* SqlClient.SqlClient;
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const query = yield* ProjectionSnapshotQuery;
        yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES (${kind}, 'Test', '/tmp/inactivity-test', '[]', ${at(0)}, ${at(0)})`;
        yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, latest_turn_id, created_at, updated_at)
        VALUES (${threadId}, ${kind}, 'Worker', '{"instanceId":"codex","model":"test"}', 'full-access', 'default', ${turnId}, ${at(0)}, ${at(0)})`;
        yield* sql`INSERT INTO projection_turns
        (thread_id, turn_id, state, requested_at, started_at, checkpoint_files_json)
        VALUES (${threadId}, ${turnId}, 'running', ${at(0)}, ${at(0)}, '[]')`;
        const subscription: SavedSubscription = {
          subscriberThreadId: "executive",
          subscriberAgentName: null,
          subscriberEnvironment: "test",
          sourceThreadId: threadId,
          sourceAgentName: "worker",
          sourceEnvironment: "test",
          createdAt: at(0),
          updatedAt: at(0),
          level: "attention",
          inactivityMinutes: 15,
        };
        const read = Effect.fn(function* () {
          const snapshot = Option.getOrThrow(yield* query.getThreadDetailSnapshot(threadId));
          return {
            ...snapshot.thread,
            parentThreadId: snapshot.thread.parentThreadId ?? null,
            settledOverride: snapshot.thread.settledOverride ?? null,
            settledAt: snapshot.thread.settledAt ?? null,
            unsettledAt: snapshot.thread.unsettledAt ?? null,
            messages: snapshot.thread.messages.map((message) => ({ ...message })),
            proposedPlans: snapshot.thread.proposedPlans.map((plan) => ({ ...plan })),
            checkpoints: snapshot.thread.checkpoints.map((checkpoint) => ({ ...checkpoint })),
            modelSelection: { provider: "codex", model: "test" },
            activities: snapshot.thread.activities.map((activity) => ({ ...activity })),
          } satisfies OrchestrationThread;
        });
        let activityId: string | undefined;
        for (let minute = 0; minute <= 20; minute++) {
          const base = {
            provider: ProviderDriverKind.make("codex"),
            eventId: EventId.make("same-provider-item"),
            threadId,
            turnId,
            createdAt: at(minute),
            sessionSequence: minute + 1,
          };
          const runtimeEvent =
            kind === "task.progress"
              ? ({
                  ...base,
                  type: "task.progress",
                  payload: {
                    taskId: RuntimeTaskId.make("same-task"),
                    description: "Working",
                    summary: "Executing tool",
                    lastToolName: "exec_command",
                  },
                } satisfies ProviderRuntimeEvent)
              : ({
                  ...base,
                  type: "item.updated",
                  itemId: RuntimeItemId.make("same-tool"),
                  payload: {
                    itemType: "command_execution",
                    status: "inProgress",
                    title: "Tool",
                    detail: `output ${minute}`,
                  },
                } satisfies ProviderRuntimeEvent);
          const activities = runtimeEventToActivities(runtimeEvent);
          assert.strictEqual(activities.length, 1);
          for (const activity of activities) {
            const event = yield* store.append({
              type: "thread.activity-appended",
              eventId: EventId.make(`append-${kind}-${minute}`),
              aggregateKind: "thread",
              aggregateId: threadId,
              occurredAt: at(minute),
              commandId: null,
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload: { threadId, activity },
            });
            yield* pipeline.projectEvent(event);
          }
          const thread = yield* read();
          assert.strictEqual(thread.activities.length, 1);
          activityId ??= String(thread.activities[0]!.id);
          assert.strictEqual(thread.activities[0]!.id, activityId);
          assert.strictEqual(thread.activities[0]!.createdAt, at(minute));
          assert.strictEqual(thread.activities[0]!.sequence, minute + 1);
          assert.isFalse(observeInactivity(subscription, thread, at(minute)));
          assert.strictEqual(subscription.inactivityObservation?.activityAt, at(minute));
        }
        // No new provider evidence: reads alone must not keep the worker healthy.
        for (let minute = 21; minute < 35; minute++)
          assert.isFalse(observeInactivity(subscription, yield* read(), at(minute)));
        assert.isTrue(observeInactivity(subscription, yield* read(), at(35)));
      }),
    );
  }
});
