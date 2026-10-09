import { ThreadRecoveryError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const fail = (cause: unknown) =>
  Schema.is(ThreadRecoveryError)(cause)
    ? cause
    : new ThreadRecoveryError({ code: "storage", message: "Recovery persistence failed." });
export class RecoveryStore extends Context.Service<
  RecoveryStore,
  {
    readonly generation: (threadId: ThreadId) => Effect.Effect<number, ThreadRecoveryError>;
    readonly advance: (
      threadId: ThreadId,
      expected: number,
    ) => Effect.Effect<number, ThreadRecoveryError>;
    readonly get: (
      id: string,
    ) => Effect.Effect<
      { principal: string; fingerprint: string; payload: unknown } | undefined,
      ThreadRecoveryError
    >;
    readonly save: (
      id: string,
      principal: string,
      fingerprint: string,
      payload: unknown,
    ) => Effect.Effect<void, ThreadRecoveryError>;
    readonly fence: (
      id: string,
      threadId: ThreadId,
      operationId: string,
      runOrdinal: number,
    ) => Effect.Effect<void, ThreadRecoveryError>;
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | ThreadRecoveryError, R>;
  }
>()("t3/threadRecovery/RecoveryStore") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const generation = (threadId: ThreadId) =>
    sql<{
      generation: number;
    }>`SELECT generation FROM fork_recovery_generations WHERE thread_id=${threadId}`.pipe(
      Effect.map((r) => r[0]?.generation ?? 0),
      Effect.mapError(fail),
    );
  const advance = (threadId: ThreadId, expected: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* generation(threadId)) !== expected)
            return yield* new ThreadRecoveryError({
              code: "conflict",
              message: "Thread generation changed.",
            });
          yield* sql`INSERT INTO fork_recovery_generations(thread_id,generation) VALUES(${threadId},${expected + 1}) ON CONFLICT(thread_id) DO UPDATE SET generation=excluded.generation`;
          return expected + 1;
        }),
      )
      .pipe(Effect.mapError(fail));
  const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
  const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
  return RecoveryStore.of({
    generation,
    advance,
    get: (id) =>
      sql<{
        principal: string;
        fingerprint: string;
        payload: string;
      }>`SELECT principal,fingerprint,payload FROM fork_recovery_operations WHERE operation_id=${id}`.pipe(
        Effect.flatMap((rows) =>
          rows[0]
            ? decode(rows[0].payload).pipe(Effect.map((payload) => ({ ...rows[0]!, payload })))
            : Effect.succeed(undefined),
        ),
        Effect.mapError(fail),
      ),
    save: (id, principal, fingerprint, payload) =>
      json(payload).pipe(
        Effect.flatMap(
          (encoded) =>
            sql`INSERT INTO fork_recovery_operations(operation_id,principal,fingerprint,payload) VALUES(${id},${principal},${fingerprint},${encoded}) ON CONFLICT(operation_id) DO UPDATE SET payload=excluded.payload`,
        ),
        Effect.asVoid,
        Effect.mapError(fail),
      ),
    fence: (id, threadId, operationId, runOrdinal) =>
      sql`INSERT INTO fork_recovery_session_fences(session_id,thread_id,operation_id,run_ordinal) VALUES(${id},${threadId},${operationId},${runOrdinal}) ON CONFLICT(session_id,thread_id) DO UPDATE SET operation_id=excluded.operation_id,run_ordinal=excluded.run_ordinal`.pipe(
        Effect.asVoid,
        Effect.mapError(fail),
      ),
    transaction: (effect) => sql.withTransaction(effect).pipe(Effect.mapError(fail)),
  });
});
export const layer = Layer.effect(RecoveryStore, make);
