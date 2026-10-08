import type { ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TxRef from "effect/TxRef";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { releaseHeldHandoffs } from "./HandoffService.ts";

/** Releases sends held for a settled thread whenever that thread is unsettled. */
export class HeldHandoffRelease extends Context.Service<
  HeldHandoffRelease,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves once every event stored before the call is handled and its release has run. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/forkThreads/HeldHandoffRelease") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providers = (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const latest = (yield* OrchestrationEventStore.OrchestrationEventStore)
    .latestAgentSequence()
    .pipe(Effect.orDie);
  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    releaseHeldHandoffs(sql, threads, providers, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Held handoff release failed", { threadId, error }),
      ),
    ),
  );
  // The cursor starts at construction, so an unsettle stored before the parked
  // subscriber first pulls is replayed, and a failed stream resumes without loss.
  const handled = yield* TxRef.make(yield* latest);
  const start = Effect.fn("HeldHandoffRelease.start")(function* () {
    yield* forkParked(
      TxRef.get(handled).pipe(
        Effect.flatMap((afterSequence) =>
          Stream.runForEach(threads.streamStoredEventsFrom({ afterSequence }), (stored) =>
            (stored.event.type === "thread.unsettled"
              ? worker.enqueue(stored.event.threadId)
              : Effect.void
            ).pipe(Effect.andThen(TxRef.set(handled, stored.sequence))),
          ),
        ),
        Effect.tapError((error) =>
          Effect.logWarning("Held handoff release stream failed; resuming", { error }),
        ),
        Effect.retry(Schedule.spaced("5 seconds")),
      ),
    );
  });
  const drain = Effect.gen(function* () {
    const target = yield* latest;
    yield* TxRef.get(handled).pipe(
      Effect.tap((sequence) => (sequence < target ? Effect.txRetry : Effect.void)),
      Effect.tx,
    );
    yield* worker.drain;
  });
  return HeldHandoffRelease.of({ start, drain });
});

export const layer = Layer.effect(HeldHandoffRelease, make);
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* HeldHandoffRelease).start();
  }),
).pipe(Layer.provide(layer), Layer.provide(ThreadManagement.layer));
