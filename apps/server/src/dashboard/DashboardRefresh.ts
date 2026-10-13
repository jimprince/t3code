import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
/** Concurrent refresh callers share the same result; failures clear the flight for the next attempt. */
export function singleFlight<A, E, R>(refresh: Effect.Effect<A, E, R>) {
  let flight: Deferred.Deferred<A, E> | null = null;
  return Effect.suspend(() => {
    if (flight) return Deferred.await(flight);
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const pending = Deferred.makeUnsafe<A, E>();
        flight = pending;
        const result = yield* Effect.exit(restore(refresh));
        yield* Deferred.done(pending, result);
        flight = null;
        return yield* Exit.isSuccess(result)
          ? Effect.succeed(result.value)
          : Effect.failCause(result.cause);
      }),
    );
  });
}
