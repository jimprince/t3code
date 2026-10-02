import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Option from "effect/Option";
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
const WORKER = ThreadId.make("worker");

it.layer(Layer.fresh(TestLayer))("completion preference projection", (it) => {
  it.effect(
    "persists explicit completion defaults through shell/detail/archive and reversible lifecycle writes",
    () =>
      Effect.gen(function* () {
        const store = yield* OrchestrationEventStore;
        const pipeline = yield* OrchestrationProjectionPipeline;
        const snapshots = yield* ProjectionSnapshotQuery;
        let sequence = 0;
        const append = (type: string, payload: Record<string, unknown>) =>
          store
            .append({
              type,
              eventId: EventId.make(`completion-${++sequence}`),
              aggregateKind: type.startsWith("project.") ? "project" : "thread",
              aggregateId: (payload.threadId ?? payload.projectId) as ThreadId,
              occurredAt: NOW,
              commandId: CommandId.make(`completion-${sequence}`),
              causationEventId: null,
              correlationId: null,
              metadata: {},
              payload,
            } as Parameters<typeof store.append>[0])
            .pipe(Effect.andThen(pipeline.bootstrap));
        yield* append("project.created", {
          projectId: PROJECT,
          title: "Completion",
          workspaceRoot: "/tmp/completion",
          defaultModelSelection: null,
          scripts: [],
          createdAt: NOW,
          updatedAt: NOW,
        });
        yield* append("thread.created", {
          threadId: WORKER,
          projectId: PROJECT,
          title: "Worker",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          updatedAt: NOW,
          settleOnComplete: true,
        });
        assert.strictEqual(
          (yield* snapshots.getShellSnapshot()).threads[0]?.settleOnComplete,
          true,
        );
        assert.strictEqual((yield* snapshots.getSnapshot()).threads[0]?.settleOnComplete, true);
        yield* append("thread.meta-updated", {
          threadId: WORKER,
          settleOnComplete: false,
          updatedAt: NOW,
        });
        assert.strictEqual(
          Option.getOrThrow(yield* snapshots.getThreadDetailSnapshot(WORKER)).thread
            .settleOnComplete,
          false,
        );
        yield* append("thread.archived", { threadId: WORKER, archivedAt: NOW, updatedAt: NOW });
        assert.strictEqual(
          (yield* snapshots.getArchivedShellSnapshot()).threads[0]?.settleOnComplete,
          false,
        );
        yield* append("thread.unarchived", { threadId: WORKER, updatedAt: NOW });
        assert.strictEqual(
          (yield* snapshots.getShellSnapshot()).threads[0]?.settleOnComplete,
          false,
        );
        yield* append("thread.meta-updated", {
          threadId: WORKER,
          settleOnComplete: null,
          updatedAt: NOW,
        });
        assert.strictEqual((yield* snapshots.getSnapshot()).threads[0]?.settleOnComplete, null);
        yield* pipeline.bootstrap;
        assert.strictEqual((yield* snapshots.getSnapshot()).threads.length, 1);
      }),
  );
});
