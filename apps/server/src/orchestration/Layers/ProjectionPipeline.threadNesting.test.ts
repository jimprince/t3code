import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const TestLayer = Layer.mergeAll(
  OrchestrationProjectionPipelineLive,
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(RepositoryIdentityResolver.layer),
  ),
).pipe(
  Layer.provideMerge(OrchestrationEventStoreLive),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-nesting-" })),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(NodeServices.layer),
);

const NOW = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-nesting");
const ORCHESTRATOR = ThreadId.make("orchestrator");
const WORKER = ThreadId.make("worker");

it.layer(Layer.fresh(TestLayer))("thread nesting projection", (it) => {
  it.effect("persists the parent link through lifecycle writes and every read path", () =>
    Effect.gen(function* () {
      const eventStore = yield* OrchestrationEventStore;
      const pipeline = yield* OrchestrationProjectionPipeline;
      const snapshots = yield* ProjectionSnapshotQuery;
      let sequence = 0;
      const append = (type: string, payload: Record<string, unknown>) =>
        eventStore.append({
          type,
          eventId: EventId.make(`evt-nesting-${++sequence}`),
          aggregateKind: type.startsWith("project.") ? "project" : "thread",
          aggregateId: (payload.threadId ?? payload.projectId) as ThreadId,
          occurredAt: NOW,
          commandId: CommandId.make(`cmd-nesting-${sequence}`),
          causationEventId: null,
          correlationId: null,
          metadata: {},
          payload,
        } as Parameters<typeof eventStore.append>[0]);
      const createThread = (threadId: ThreadId, parentThreadId?: ThreadId) =>
        append("thread.created", {
          threadId,
          projectId: PROJECT,
          title: String(threadId),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
          ...(parentThreadId ? { parentThreadId } : {}),
        });
      const parentOf = Effect.gen(function* () {
        const shell = yield* snapshots.getShellSnapshot();
        const readModel = yield* snapshots.getSnapshot();
        return {
          shell: shell.threads.find((thread) => thread.id === WORKER)?.parentThreadId ?? null,
          readModel:
            readModel.threads.find((thread) => thread.id === WORKER)?.parentThreadId ?? null,
        };
      });

      yield* append("project.created", {
        projectId: PROJECT,
        title: "Nesting",
        workspaceRoot: "/tmp/nesting",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      });
      yield* createThread(ORCHESTRATOR);
      yield* createThread(WORKER, ORCHESTRATOR);
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* parentOf, { shell: ORCHESTRATOR, readModel: ORCHESTRATOR });

      // A later lifecycle event rewrites the whole row; the link must survive it.
      yield* append("thread.settled", { threadId: WORKER, settledAt: NOW, updatedAt: NOW });
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* parentOf, { shell: ORCHESTRATOR, readModel: ORCHESTRATOR });

      yield* append("thread.meta-updated", {
        threadId: WORKER,
        parentThreadId: null,
        updatedAt: NOW,
      });
      yield* pipeline.bootstrap;
      assert.deepEqual(yield* parentOf, { shell: null, readModel: null });
    }),
  );
});
