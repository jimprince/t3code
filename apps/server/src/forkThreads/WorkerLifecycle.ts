import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata, listMetadata } from "./MetadataStore.ts";
import { isPermanentRoot } from "./PermanentRoots.ts";
import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { archiveDeadline, archiveEligible, hasActiveWork } from "./ArchiveDeadlines.ts";
import { hasLiveChildren } from "./WorkerLifecycleMetadata.ts";
import { completionEligible } from "./WorkerLifecyclePolicy.ts";

export class WorkerLifecycle extends Context.Service<
  WorkerLifecycle,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/forkThreads/WorkerLifecycle") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* initializeMetadata(sql).pipe(Effect.orDie);
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const scope = yield* Scope.Scope;
  let timer: Fiber.Fiber<void> | undefined;
  let queued = false;
  let enqueue: () => Effect.Effect<void> = () => Effect.void;
  const worker = yield* makeDrainableWorker((_item: undefined) =>
    Effect.gen(function* () {
      queued = false;
      if (timer) {
        yield* Fiber.interrupt(timer);
        timer = undefined;
      }
      const active = yield* threads.getShellSnapshot();
      const archived = yield* threads.getShellSnapshot({ location: "archive" });
      const all = [...active.threads, ...archived.threads];
      const metadata = new Map((yield* listMetadata(sql)).map((row) => [row.threadId, row]));
      const settings = yield* settingsService.getSettings;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let nearest = Infinity;
      for (const thread of active.threads) {
        const policy = resolveProjectSettings(settings, thread.projectId).settings;
        const onComplete =
          metadata.get(thread.id)?.settleOnComplete ??
          ((metadata.get(thread.id)?.parentThreadId != null ||
            metadata.get(thread.id)?.remoteParent != null) &&
            policy.subthreadSettleOnComplete);
        if (
          onComplete &&
          thread.settledOverride == null &&
          !thread.autoSettleDisabledAt &&
          !thread.pinnedAt &&
          !isPermanentRoot(thread.id) &&
          !hasActiveWork(thread) &&
          thread.status === "completed" &&
          thread.latestRunId
        ) {
          const projection = yield* threads.getThreadProjection(thread.id);
          if (
            completionEligible(projection, thread.latestRunId, metadata.get(thread.id)) &&
            !(yield* hasLiveChildren(sql, thread.id))
          ) {
            yield* threads
              .dispatch({
                type: "thread.auto-settle",
                threadId: thread.id,
                commandId: CommandId.make(
                  `fork:complete:${thread.id}:${thread.latestRunId}:${DateTime.toEpochMillis(thread.updatedAt)}`,
                ),
                snapshotAt: thread.updatedAt,
                completionRunId: thread.latestRunId,
              })
              .pipe(
                Effect.andThen(Effect.suspend(enqueue)),
                Effect.catch((error) =>
                  Effect.logWarning("Worker completion raced", { threadId: thread.id, error }),
                ),
              );
          }
        }
        const days = policy.settledSubthreadArchiveAfterDays;
        if (days == null || !archiveEligible(thread, all, now, metadata.get(thread.id), metadata))
          continue;
        const deadline = archiveDeadline(thread, days);
        if (deadline == null) continue;
        if (deadline > now) {
          nearest = Math.min(nearest, deadline);
          continue;
        }
        yield* threads
          .dispatch({
            type: "thread.archive",
            threadId: thread.id,
            commandId: CommandId.make(`fork:archive:${thread.id}:${deadline}`),
            autoArchiveSettledBefore: DateTime.makeUnsafe(now - days * 86_400_000),
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Worker archive raced", { threadId: thread.id, error }),
            ),
          );
      }
      if (Number.isFinite(nearest))
        timer = yield* Effect.sleep(Math.max(1, nearest - now)).pipe(
          Effect.andThen(Effect.suspend(enqueue)),
          Effect.forkIn(scope),
        );
    }).pipe(Effect.catch((error) => Effect.logWarning("Worker lifecycle sweep failed", { error }))),
  );
  enqueue = () =>
    Effect.suspend(() => {
      if (queued) return Effect.void;
      queued = true;
      return worker.enqueue(undefined);
    });
  const start = Effect.fn("WorkerLifecycle.start")(function* () {
    const changes = yield* settingsService.subscribeChanges;
    yield* forkParked(
      Effect.gen(function* () {
        yield* enqueue();
        yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          [
            "thread.created",
            "thread.metadata-updated",
            "thread.settled",
            "thread.archived",
            "thread.unarchived",
            "thread.deleted",
            "thread.pinned",
            "thread.unpinned",
            "thread.unsettled",
            "thread.auto-settle-set",
            "run.background-work-cancelled",
            "provider-thread.updated",
            "subagent.updated",
            "run.updated",
            "runtime-request.updated",
            "plan.updated",
          ].includes(event.type)
            ? enqueue()
            : Effect.void,
        );
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Worker lifecycle stream failed", { error })),
      ),
    );
    yield* forkParked(Stream.runForEach(changes, () => enqueue()));
  });
  return WorkerLifecycle.of({
    start,
    drain: Effect.suspend(enqueue).pipe(Effect.andThen(worker.drain)),
  });
});

export const layer = Layer.effect(WorkerLifecycle, make);
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const service = yield* WorkerLifecycle;
    yield* service.start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ThreadManagement.layer));
