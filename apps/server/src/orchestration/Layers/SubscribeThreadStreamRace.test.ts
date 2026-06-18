import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);

const now = "2026-01-01T00:00:00.000Z";

async function createHarness(prefix: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix });
  const orchestrationLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(orchestrationLayer);
  return {
    engine: await runtime.runPromise(Effect.service(OrchestrationEngineService)),
    snapshotQuery: await runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function seedProjectAndThread(input: {
  readonly engine: typeof OrchestrationEngineService.Service;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  return Effect.gen(function* () {
    yield* input.engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-${input.projectId}-create`),
      projectId: input.projectId,
      title: "Snapshot race project",
      workspaceRoot: `/tmp/${input.projectId}`,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt: now,
    });

    yield* input.engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-${input.threadId}-create`),
      threadId: input.threadId,
      projectId: input.projectId,
      title: "Snapshot race thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
    });
  });
}

it.effect("getThreadDetailSnapshotById returns an atomic thread detail cut point", () =>
  Effect.promise(async () => {
    const harness = await createHarness("t3-subscribe-thread-snapshot-");
    try {
      const projectId = asProjectId("project-thread-snapshot");
      const threadId = asThreadId("thread-snapshot");

      await harness.run(
        seedProjectAndThread({
          engine: harness.engine,
          projectId,
          threadId,
        }),
      );
      const turnResult = await harness.run(
        harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-thread-snapshot-turn-start"),
          threadId,
          message: {
            messageId: asMessageId("message-thread-snapshot-user"),
            role: "user",
            text: "hello from the snapshot",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt: now,
        }),
      );

      const snapshot = await harness.run(
        harness.snapshotQuery.getThreadDetailSnapshotById(threadId),
      );
      const currentSequence = await harness.run(harness.snapshotQuery.getSnapshotSequence());

      assert.equal(snapshot._tag, "Some");
      if (Option.isSome(snapshot)) {
        assert.equal(snapshot.value.snapshotSequence, turnResult.sequence);
        assert.equal(snapshot.value.snapshotSequence, currentSequence.snapshotSequence);
        assert.equal(snapshot.value.thread.id, threadId);
        assert.equal(snapshot.value.thread.title, "Snapshot race thread");
        assert.deepStrictEqual(snapshot.value.thread.messages, [
          {
            id: asMessageId("message-thread-snapshot-user"),
            role: "user",
            text: "hello from the snapshot",
            turnId: null,
            streaming: false,
            attachments: [],
            createdAt: now,
            updatedAt: now,
          },
        ]);
      }
    } finally {
      await harness.dispose();
    }
  }),
);

it.effect(
  "subscribeDomainEvents buffers thread-detail events dispatched after the snapshot cut",
  () =>
    Effect.promise(async () => {
      const harness = await createHarness("t3-subscribe-thread-live-");
      try {
        const projectId = asProjectId("project-thread-live");
        const threadId = asThreadId("thread-live");

        await harness.run(
          seedProjectAndThread({
            engine: harness.engine,
            projectId,
            threadId,
          }),
        );

        const deliveredEvent = await harness.run(
          Effect.scoped(
            Effect.gen(function* () {
              const liveStream = yield* harness.engine.subscribeDomainEvents;
              const snapshot = yield* harness.snapshotQuery.getThreadDetailSnapshotById(threadId);
              assert.equal(snapshot._tag, "Some");
              if (Option.isNone(snapshot)) {
                return yield* Effect.die("expected thread snapshot to exist");
              }

              yield* harness.engine.dispatch({
                type: "thread.meta.update",
                commandId: CommandId.make("cmd-thread-live-meta-update"),
                threadId,
                title: "Updated after snapshot",
              });

              const events = yield* liveStream.pipe(
                Stream.filter(
                  (event) =>
                    event.sequence > snapshot.value.snapshotSequence &&
                    event.aggregateKind === "thread" &&
                    event.aggregateId === threadId &&
                    event.type === "thread.meta-updated",
                ),
                Stream.take(1),
                Stream.runCollect,
                Effect.timeout("1 second"),
              );
              const delivered = Array.from(events) as OrchestrationEvent[];
              assert.equal(delivered.length, 1);
              return delivered[0]!;
            }),
          ),
        );

        assert.equal(deliveredEvent.type, "thread.meta-updated");
        if (deliveredEvent.type !== "thread.meta-updated") {
          throw new Error(`expected thread.meta-updated, received ${deliveredEvent.type}`);
        }
        assert.equal(deliveredEvent.aggregateId, threadId);
        assert.equal(deliveredEvent.payload.threadId, threadId);
        assert.equal(deliveredEvent.payload.title, "Updated after snapshot");
        assert.equal(typeof deliveredEvent.payload.updatedAt, "string");
      } finally {
        await harness.dispose();
      }
    }),
);
