import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import {
  IsoDateTime,
  ProviderInstanceId,
  ProviderSessionRuntimeStatus,
  RuntimeMode,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  type ProviderSessionRuntimeRepositoryError,
} from "./Errors.ts";

/**
 * ProviderSessionRuntimeRepository - Repository interface for provider runtime sessions.
 *
 * Owns persistence operations for provider runtime metadata and resume cursors.
 *
 * @module ProviderSessionRuntimeRepository
 */

export const ProviderSessionRuntime = Schema.Struct({
  threadId: ThreadId,
  providerName: Schema.String,
  /**
   * User-defined routing key for the configured provider instance that
   * owns this session. Nullable only at the storage/migration boundary:
   * rows persisted before the driver/instance split carry only
   * `providerName`. Repository consumers must materialize a concrete
   * instance id before routing.
   */
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  bootGenerationId: Schema.NullOr(Schema.String),
  adapterKey: Schema.String,
  runtimeMode: RuntimeMode,
  status: ProviderSessionRuntimeStatus,
  // Optional on writes so older call sites and imported snapshots remain
  // source-compatible. Rows read from SQLite always materialize this column.
  activeTurnId: Schema.optional(Schema.NullOr(TurnId)),
  lastSeenAt: IsoDateTime,
  resumeCursor: Schema.NullOr(Schema.Unknown),
  runtimePayload: Schema.NullOr(Schema.Unknown),
});
export type ProviderSessionRuntime = typeof ProviderSessionRuntime.Type;

export const GetProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type GetProviderSessionRuntimeInput = typeof GetProviderSessionRuntimeInput.Type;

export const DeleteProviderSessionRuntimeInput = Schema.Struct({ threadId: ThreadId });
export type DeleteProviderSessionRuntimeInput = typeof DeleteProviderSessionRuntimeInput.Type;

export interface SettleDeadGenerationRuntimeInput {
  readonly threadId: ThreadId;
  readonly expectedBootGenerationId: string | null;
  readonly currentBootGenerationId: string;
  readonly lastSeenAt: typeof IsoDateTime.Type;
}

export interface MarkProviderTurnStartedInput {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly expectedActiveTurnId?: TurnId | null;
  readonly currentBootGenerationId: string;
  readonly lastSeenAt: typeof IsoDateTime.Type;
}

export interface MarkProviderTurnTerminalInput {
  readonly threadId: ThreadId;
  readonly expectedTurnId: TurnId;
  readonly currentBootGenerationId: string;
  readonly lastSeenAt: typeof IsoDateTime.Type;
}

export interface ClaimIdleProviderSessionInput {
  readonly threadId: ThreadId;
  readonly expectedLastSeenAt: typeof IsoDateTime.Type;
  readonly currentBootGenerationId: string;
  readonly lastSeenAt: typeof IsoDateTime.Type;
}

/**
 * ProviderSessionRuntimeRepository - Service tag for provider runtime persistence.
 */
export class ProviderSessionRuntimeRepository extends Context.Service<
  ProviderSessionRuntimeRepository,
  {
    /**
     * Insert or replace a provider runtime row.
     *
     * Upserts by canonical `threadId`, including JSON payload/cursor fields.
     */
    readonly upsert: (
      runtime: ProviderSessionRuntime,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;

    /**
     * Read provider runtime state by canonical thread id.
     */
    readonly getByThreadId: (
      input: GetProviderSessionRuntimeInput,
    ) => Effect.Effect<
      Option.Option<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * List all provider runtime rows.
     *
     * Returned in ascending last-seen order.
     */
    readonly list: () => Effect.Effect<
      ReadonlyArray<ProviderSessionRuntime>,
      ProviderSessionRuntimeRepositoryError
    >;

    /**
     * Atomically settles a binding only if it still belongs to the boot
     * generation observed by the caller. Resume state is preserved for lazy
     * recovery, while the dead process's active-turn marker is cleared.
     */
    readonly settleDeadGeneration: (
      input: SettleDeadGenerationRuntimeInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly markTurnStarted: (
      input: MarkProviderTurnStartedInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    readonly markTurnTerminal: (
      input: MarkProviderTurnTerminalInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    /**
     * Atomically marks a session stopped only when it is still the idle
     * snapshot observed by a recovery preview. A concurrent turn reservation
     * or any newer lifecycle update makes the claim fail without mutation.
     */
    readonly claimIdleForRecovery: (
      input: ClaimIdleProviderSessionInput,
    ) => Effect.Effect<boolean, ProviderSessionRuntimeRepositoryError>;

    /**
     * Delete provider runtime state by canonical thread id.
     */
    readonly deleteByThreadId: (
      input: DeleteProviderSessionRuntimeInput,
    ) => Effect.Effect<void, ProviderSessionRuntimeRepositoryError>;
  }
>()("t3/persistence/ProviderSessionRuntime/ProviderSessionRuntimeRepository") {}

const ProviderSessionRuntimeDbRowSchema = ProviderSessionRuntime.mapFields(
  Struct.assign({
    resumeCursor: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
    runtimePayload: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  }),
);

const ProviderSessionRuntimeRawDbRowSchema = Schema.Struct({
  threadId: Schema.String,
  providerName: Schema.Unknown,
  providerInstanceId: Schema.Unknown,
  bootGenerationId: Schema.Unknown,
  adapterKey: Schema.Unknown,
  runtimeMode: Schema.Unknown,
  status: Schema.Unknown,
  activeTurnId: Schema.Unknown,
  lastSeenAt: Schema.Unknown,
  resumeCursor: Schema.Unknown,
  runtimePayload: Schema.Unknown,
});

const decodeRuntimeRow = Schema.decodeUnknownEffect(ProviderSessionRuntimeDbRowSchema);

const GetRuntimeRequestSchema = Schema.Struct({
  threadId: ThreadId,
});

const DeleteRuntimeRequestSchema = GetRuntimeRequestSchema;

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): ProviderSessionRuntimeRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRuntimeRow = SqlSchema.void({
    Request: ProviderSessionRuntimeDbRowSchema,
    execute: (runtime) =>
      sql`
        INSERT INTO provider_session_runtime (
          thread_id,
          provider_name,
          provider_instance_id,
          boot_generation_id,
          adapter_key,
          runtime_mode,
          status,
          active_turn_id,
          last_seen_at,
          resume_cursor_json,
          runtime_payload_json
        )
        VALUES (
          ${runtime.threadId},
          ${runtime.providerName},
          ${runtime.providerInstanceId},
          ${runtime.bootGenerationId},
          ${runtime.adapterKey},
          ${runtime.runtimeMode},
          ${runtime.status},
          ${runtime.activeTurnId ?? null},
          ${runtime.lastSeenAt},
          ${runtime.resumeCursor},
          ${runtime.runtimePayload}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          provider_name = excluded.provider_name,
          provider_instance_id = excluded.provider_instance_id,
          boot_generation_id = excluded.boot_generation_id,
          adapter_key = excluded.adapter_key,
          runtime_mode = excluded.runtime_mode,
          status = excluded.status,
          active_turn_id = excluded.active_turn_id,
          last_seen_at = excluded.last_seen_at,
          resume_cursor_json = excluded.resume_cursor_json,
          runtime_payload_json = excluded.runtime_payload_json
      `,
  });

  const getRuntimeRowByThreadId = SqlSchema.findOneOption({
    Request: GetRuntimeRequestSchema,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          boot_generation_id AS "bootGenerationId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          active_turn_id AS "activeTurnId",
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const listRuntimeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProviderSessionRuntimeRawDbRowSchema,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          provider_name AS "providerName",
          provider_instance_id AS "providerInstanceId",
          boot_generation_id AS "bootGenerationId",
          adapter_key AS "adapterKey",
          runtime_mode AS "runtimeMode",
          status,
          active_turn_id AS "activeTurnId",
          last_seen_at AS "lastSeenAt",
          resume_cursor_json AS "resumeCursor",
          runtime_payload_json AS "runtimePayload"
        FROM provider_session_runtime
        ORDER BY last_seen_at ASC, thread_id ASC
      `,
  });

  const deleteRuntimeByThreadId = SqlSchema.void({
    Request: DeleteRuntimeRequestSchema,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM provider_session_runtime
        WHERE thread_id = ${threadId}
      `,
  });

  const settleDeadGeneration: ProviderSessionRuntimeRepository["Service"]["settleDeadGeneration"] =
    (input) =>
      sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET
          status = 'stopped',
          active_turn_id = NULL,
          boot_generation_id = ${input.currentBootGenerationId},
          last_seen_at = ${input.lastSeenAt},
          runtime_payload_json = json_set(
            COALESCE(runtime_payload_json, '{}'),
            '$.activeTurnId',
            NULL
          )
        WHERE thread_id = ${input.threadId}
          AND status != 'stopped'
          AND boot_generation_id IS ${input.expectedBootGenerationId}
        RETURNING thread_id AS "threadId"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({
              operation: "ProviderSessionRuntimeRepository.settleDeadGeneration:query",
              correlation: { threadId: input.threadId },
              cause,
            }),
        ),
      );

  const markTurnStarted: ProviderSessionRuntimeRepository["Service"]["markTurnStarted"] = (input) =>
    sql<{ readonly threadId: string }>`
      UPDATE provider_session_runtime
      SET
        status = 'running',
        active_turn_id = ${input.turnId},
        boot_generation_id = ${input.currentBootGenerationId},
        last_seen_at = ${input.lastSeenAt},
        runtime_payload_json = json_set(
          COALESCE(runtime_payload_json, '{}'),
          '$.activeTurnId',
          ${input.turnId}
        )
      WHERE thread_id = ${input.threadId}
        AND status != 'stopped'
        AND (
          ${input.expectedActiveTurnId === undefined ? 1 : 0} = 1
          OR active_turn_id IS ${input.expectedActiveTurnId ?? null}
        )
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProviderSessionRuntimeRepository.markTurnStarted:query",
            correlation: { threadId: input.threadId },
            cause,
          }),
      ),
    );

  const markTurnTerminal: ProviderSessionRuntimeRepository["Service"]["markTurnTerminal"] = (
    input,
  ) =>
    sql<{ readonly threadId: string }>`
      UPDATE provider_session_runtime
      SET
        active_turn_id = NULL,
        boot_generation_id = ${input.currentBootGenerationId},
        last_seen_at = ${input.lastSeenAt},
        runtime_payload_json = json_set(
          COALESCE(runtime_payload_json, '{}'),
          '$.activeTurnId',
          NULL
        )
      WHERE thread_id = ${input.threadId}
        AND active_turn_id = ${input.expectedTurnId}
      RETURNING thread_id AS "threadId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProviderSessionRuntimeRepository.markTurnTerminal:query",
            correlation: { threadId: input.threadId },
            cause,
          }),
      ),
    );

  const claimIdleForRecovery: ProviderSessionRuntimeRepository["Service"]["claimIdleForRecovery"] =
    (input) =>
      sql<{ readonly threadId: string }>`
        UPDATE provider_session_runtime
        SET
          status = 'stopped',
          active_turn_id = NULL,
          boot_generation_id = ${input.currentBootGenerationId},
          last_seen_at = ${input.lastSeenAt},
          runtime_payload_json = json_set(
            COALESCE(runtime_payload_json, '{}'),
            '$.activeTurnId',
            NULL
          )
        WHERE thread_id = ${input.threadId}
          AND status != 'stopped'
          AND active_turn_id IS NULL
          AND last_seen_at = ${input.expectedLastSeenAt}
        RETURNING thread_id AS "threadId"
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(
          (cause) =>
            new PersistenceSqlError({
              operation: "ProviderSessionRuntimeRepository.claimIdleForRecovery:query",
              correlation: { threadId: input.threadId },
              cause,
            }),
        ),
      );

  const upsert: ProviderSessionRuntimeRepository["Service"]["upsert"] = (runtime) =>
    upsertRuntimeRow(runtime).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.upsert:query",
          "ProviderSessionRuntimeRepository.upsert:encodeRequest",
          { threadId: runtime.threadId },
        ),
      ),
    );

  const getByThreadId: ProviderSessionRuntimeRepository["Service"]["getByThreadId"] = (input) =>
    getRuntimeRowByThreadId(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.getByThreadId:query",
          "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
          { threadId: input.threadId },
        ),
      ),
      Effect.flatMap((runtimeRowOption) =>
        Option.match(runtimeRowOption, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeRuntimeRow(row).pipe(
              Effect.mapError((cause) =>
                PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.getByThreadId:decodeRow",
                  cause,
                  { threadId: input.threadId },
                ),
              ),
              Effect.map((runtime) => Option.some(runtime)),
            ),
        }),
      ),
    );

  const list: ProviderSessionRuntimeRepository["Service"]["list"] = () =>
    listRuntimeRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProviderSessionRuntimeRepository.list:query",
          "ProviderSessionRuntimeRepository.list:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        // Skip rows that no longer decode (e.g. written by an older build)
        // instead of failing the whole list — one stale row must not disable
        // every consumer that enumerates sessions, such as the reaper.
        Effect.forEach(rows, (row) =>
          decodeRuntimeRow(row).pipe(
            Effect.map(Option.some),
            Effect.catch((cause) =>
              Effect.logWarning("provider.session.runtime.row-skipped", {
                threadId: row.threadId,
                error: PersistenceDecodeError.fromSchemaError(
                  "ProviderSessionRuntimeRepository.list:decodeRows",
                  cause,
                  { threadId: row.threadId },
                ).message,
              }).pipe(Effect.as(Option.none<ProviderSessionRuntime>())),
            ),
          ),
        ),
      ),
      Effect.map((decoded) =>
        Arr.filterMap(decoded, (row) =>
          Option.isSome(row) ? Result.succeed(row.value) : Result.failVoid,
        ),
      ),
    );

  const deleteByThreadId: ProviderSessionRuntimeRepository["Service"]["deleteByThreadId"] = (
    input,
  ) =>
    deleteRuntimeByThreadId(input).pipe(
      Effect.mapError(
        (cause) =>
          new PersistenceSqlError({
            operation: "ProviderSessionRuntimeRepository.deleteByThreadId:query",
            correlation: { threadId: input.threadId },
            cause,
          }),
      ),
    );

  return {
    upsert,
    getByThreadId,
    list,
    settleDeadGeneration,
    markTurnStarted,
    markTurnTerminal,
    claimIdleForRecovery,
    deleteByThreadId,
  } satisfies ProviderSessionRuntimeRepository["Service"];
});

export const layer = Layer.effect(ProviderSessionRuntimeRepository, make);
