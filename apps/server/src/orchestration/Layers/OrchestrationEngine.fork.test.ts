/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- verbatim copies of the upstream test file's harness helpers; the upstream file carries the same legacy allowance. */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEventStore,
  type OrchestrationEventStoreShape,
} from "../../persistence/Services/OrchestrationEventStore.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
} from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
// Fork-added test cases extracted from the upstream test file so that upstream
// edits to that file never conflict with the fork. Helpers are copied, not
// imported: upstream keeps them file-local.

const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const asEventId = (value: string): EventId => EventId.make(value);

function makeOrchestrationLayer() {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "t3-orchestration-engine-test-",
  });
  return Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

async function createOrchestrationSystem() {
  const runtime = ManagedRuntime.make(makeOrchestrationLayer());
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    readModel: () => runtime.runPromise(snapshotQuery.getSnapshot()),
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

describe("OrchestrationEngine (fork)", () => {
  it("catches up command state with events appended outside the running engine", async () => {
    type StoredEvent =
      ReturnType<OrchestrationEventStoreShape["append"]> extends Effect.Effect<infer A, any, any>
        ? A
        : never;
    const events: StoredEvent[] = [];
    let nextSequence = 1;
    const createdAt = now();
    const projectId = asProjectId("project-external-create");

    const eventStore: OrchestrationEventStoreShape = {
      append: (event) =>
        Effect.sync(() => {
          const savedEvent = {
            ...event,
            sequence: nextSequence,
          } as StoredEvent;
          nextSequence += 1;
          events.push(savedEvent);
          return savedEvent;
        }),
      readFromSequence: (sequenceExclusive) =>
        Stream.fromIterable(events.filter((event) => event.sequence > sequenceExclusive)),
      readAggregateRange: () => Stream.die("unused aggregate replay"),
      getAggregateReplayStats: () => Effect.die("unused aggregate replay stats"),
      readAll: () => Stream.fromIterable(events),
      hasEventAfter: (input) =>
        Effect.succeed(
          events.some(
            (event) =>
              event.aggregateKind === input.aggregateKind &&
              event.aggregateId === input.aggregateId &&
              event.type === input.type &&
              event.sequence > input.sequenceExclusive,
          ),
        ),
    };

    const projectionSnapshot = {
      snapshotSequence: 0,
      updatedAt: "1970-01-01T00:00:00.000Z",
      projects: [],
      threads: [],
    };

    const layer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.succeed(projectionSnapshot),
          getSnapshot: () => Effect.succeed(projectionSnapshot),
          getShellSnapshot: () => Effect.succeed(projectionSnapshot),
          getArchivedShellSnapshot: () => Effect.succeed(projectionSnapshot),
          searchThreads: () => Effect.succeed({ matches: [] }),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getEventReplayStats: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          getFullThreadDiffContext: () => Effect.succeed(Option.none()),
          getUserInputActivity: () => Effect.die("unused"),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadRuntimeContext: () => Effect.succeed(Option.none()),
          getThreadShellByIdIncludingArchived: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.provide(
        Layer.succeed(OrchestrationProjectionPipeline, {
          bootstrap: Effect.void,
          projectEvent: () => Effect.void,
          projectEventDeferred: () => Effect.succeed(Effect.void),
        } satisfies OrchestrationProjectionPipelineShape),
      ),
      Layer.provide(Layer.succeed(OrchestrationEventStore, eventStore)),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));

    events.push({
      sequence: nextSequence,
      eventId: asEventId("evt-project-external-create"),
      type: "project.created",
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: createdAt,
      commandId: CommandId.make("cmd-project-external-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-external-create"),
      metadata: {},
      payload: {
        projectId,
        title: "External Project",
        workspaceRoot: "/tmp/project-external-create",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    } satisfies StoredEvent);
    nextSequence += 1;

    const result = await runtime.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-external-create"),
        threadId: ThreadId.make("thread-external-create"),
        projectId,
        title: "Thread from external project",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    expect(result.sequence).toBe(2);
    expect(events.map((event) => event.type)).toEqual(["project.created", "thread.created"]);

    await runtime.dispose();
  });
  it("accepts repeated archive commands as no-ops without duplicate archive events", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;
    const createdAt = now();
    const threadId = ThreadId.make("thread-archive-idempotent");

    await system.run(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-archive-idempotent-create"),
        projectId: asProjectId("project-archive-idempotent"),
        title: "Project Archive Idempotent",
        workspaceRoot: "/tmp/project-archive-idempotent",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await system.run(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-archive-idempotent-create"),
        threadId,
        projectId: asProjectId("project-archive-idempotent"),
        title: "Archive me twice",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      }),
    );

    const firstArchive = await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive-idempotent-first"),
        threadId,
      }),
    );
    const secondArchive = await system.run(
      engine.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd-thread-archive-idempotent-second"),
        threadId,
      }),
    );

    expect(secondArchive.sequence).toBe(firstArchive.sequence);
    const events = await system.run(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): OrchestrationEvent[] => Array.from(chunk)),
      ),
    );
    expect(events.filter((event) => event.type === "thread.archived")).toHaveLength(1);
    expect(
      (await system.readModel()).threads.find((thread) => thread.id === threadId)?.archivedAt,
    ).not.toBeNull();

    await system.dispose();
  });
  it("still rejects archive commands for missing threads", async () => {
    const system = await createOrchestrationSystem();
    const { engine } = system;

    await expect(
      system.run(
        engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("cmd-thread-archive-missing"),
          threadId: ThreadId.make("thread-archive-missing"),
        }),
      ),
    ).rejects.toThrow("Thread 'thread-archive-missing' does not exist");

    await system.dispose();
  });
});
