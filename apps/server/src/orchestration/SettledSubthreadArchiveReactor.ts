import { CommandId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { isSettledSubthreadArchiveCandidate } from "./SettledSubthreadArchivePolicy.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export class SettledSubthreadArchiveReactor extends Context.Service<
  SettledSubthreadArchiveReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/SettledSubthreadArchiveReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  let timer: Fiber.Fiber<void> | undefined;

  let enqueue: () => Effect.Effect<void> = () => Effect.void;
  const worker = yield* makeDrainableWorker((_item: undefined) =>
    Effect.gen(function* () {
      if (timer !== undefined) {
        yield* Fiber.interrupt(timer);
        timer = undefined;
      }
      const snapshot = yield* snapshots.getShellSnapshot();
      const archived = yield* snapshots.getArchivedShellSnapshot();
      const threads = [...snapshot.threads, ...archived.threads];
      const settings = yield* settingsService.getSettings;
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      let nextDue = Number.POSITIVE_INFINITY;
      for (const thread of snapshot.threads) {
        const days = resolveProjectSettings(settings, thread.projectId).settings
          .settledSubthreadArchiveAfterDays;
        if (days === null || thread.settledAt === null) continue;
        // Check every guard before arming a timer. A blocked thread wakes through events.
        if (
          !isSettledSubthreadArchiveCandidate(
            thread,
            threads,
            DateTime.formatIso(DateTime.makeUnsafe(now)),
          )
        )
          continue;
        const due =
          Math.max(Date.parse(thread.settledAt), Date.parse(thread.updatedAt)) + days * DAY_MS;
        if (due > now) {
          nextDue = Math.min(nextDue, due);
          continue;
        }
        yield* engine
          .dispatch({
            type: "thread.archive",
            commandId: CommandId.make(
              `server:auto-archive:${thread.id}:${yield* crypto.randomUUIDv4}`,
            ),
            threadId: thread.id,
            autoArchiveSettledBefore: DateTime.formatIso(DateTime.makeUnsafe(now - days * DAY_MS)),
          })
          .pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                Effect.logWarning("automatic subthread archive skipped", {
                  threadId: thread.id,
                  cause: Cause.pretty(cause),
                }),
            ),
          );
      }
      if (Number.isFinite(nextDue)) {
        timer = yield* Effect.sleep(Math.max(1, nextDue - now)).pipe(
          Effect.andThen(Effect.suspend(enqueue)),
          Effect.forkIn(scope),
        );
      }
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("automatic subthread archive sweep failed", {
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  enqueue = () => worker.enqueue(undefined);

  const start = Effect.fn("SettledSubthreadArchiveReactor.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const changes = yield* settingsService.subscribeChanges;
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* Stream.runForEach(events, (event) =>
          [
            "thread.created",
            "thread.deleted",
            "thread.archived",
            "thread.unarchived",
            "thread.settled",
            "thread.unsettled",
            "thread.pinned",
            "thread.unpinned",
            "thread.auto-settle-set",
            "thread.meta-updated",
            "thread.session-set",
            "thread.turn-start-requested",
          ].includes(event.type)
            ? worker.enqueue(undefined)
            : Effect.void,
        );
      }),
    );
    yield* forkParked(Stream.runForEach(changes, () => worker.enqueue(undefined)));
  });
  return { start, drain: worker.drain };
});

export const layer = Layer.effect(SettledSubthreadArchiveReactor, make);
