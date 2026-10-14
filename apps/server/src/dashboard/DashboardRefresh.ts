import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
/** Callers share a refresh unless their write revision is newer than the in-flight read. */
export function singleFlight<A, E, R>(refresh: Effect.Effect<A, E, R>, revision = () => 0) {
  let flight: { pending: Deferred.Deferred<A, E>; revision: number } | null = null;
  let completed: { revision: number; value: A } | null = null;
  const run: Effect.Effect<A, E, R> = Effect.suspend(() => {
    const observed = revision();
    if (flight) {
      const current = flight;
      return Deferred.await(current.pending).pipe(
        Effect.flatMap((result) =>
          current.revision === observed
            ? Effect.succeed(result)
            : completed !== null && completed.revision >= observed
              ? Effect.succeed(completed.value)
              : run,
        ),
      );
    }
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const pending = Deferred.makeUnsafe<A, E>();
        flight = { pending, revision: observed };
        const result = yield* Effect.exit(restore(refresh));
        if (Exit.isSuccess(result)) completed = { revision: observed, value: result.value };
        flight = null;
        yield* Deferred.done(pending, result);
        return yield* Exit.isSuccess(result)
          ? Effect.succeed(result.value)
          : Effect.failCause(result.cause);
      }),
    );
  });
  return run;
}
