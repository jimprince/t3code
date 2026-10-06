import {
  CommandId,
  EventId,
  OrchestrationV2AppThread,
  ThreadId,
  type OrchestrationV2StoredEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { listMetadata } from "./MetadataStore.ts";
import { makeNestingService } from "./NestingService.ts";

class DelegatedWorkerRepairWriteRejectedError extends Schema.TaggedError<DelegatedWorkerRepairWriteRejectedError>()(
  "DelegatedWorkerRepairWriteRejectedError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    reason: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return "Repair write was not accepted.";
  }
}

const fields = [
  "pinnedAt",
  "pinOrderKey",
  "activeOrderKey",
  "autoSettleDisabledAt",
  "unsettledAt",
] as const;
type Field = (typeof fields)[number];
const deliberate: Record<Field, readonly string[]> = {
  pinnedAt: ["thread.pinned", "thread.unpinned", "thread.settled"],
  pinOrderKey: ["thread.pinned", "thread.unpinned", "thread.pin-reordered", "thread.settled"],
  activeOrderKey: ["thread.active-reordered", "thread.pinned", "thread.settled"],
  autoSettleDisabledAt: ["thread.auto-settle-set"],
  unsettledAt: ["thread.unsettled", "thread.settled", "thread.pinned"],
};
const scalar = (value: unknown) =>
  DateTime.isDateTime(value) ? DateTime.formatIso(value) : (value ?? null);
const isThread = Schema.is(OrchestrationV2AppThread);
function threadPayload(stored: OrchestrationV2StoredEvent) {
  return isThread(stored.event.payload) ? stored.event.payload : null;
}

export class DelegatedWorkerRepair extends Context.Service<
  DelegatedWorkerRepair,
  {
    readonly inspect: ReturnType<typeof makeDelegatedWorkerRepair>["inspect"];
    readonly apply: ReturnType<typeof makeDelegatedWorkerRepair>["apply"];
  }
>()("t3/forkThreads/DelegatedWorkerRepair") {}

/** Offline operator repair: read a consistent manifest, preserve edits, and persist replayable receipts. */
const makeDelegatedWorkerRepair = (
  sql: SqlClient.SqlClient,
  store: ProjectionStore.ProjectionStoreV2Shape,
  events: EventStore.EventStoreV2Shape,
  sink: EventSink.EventSinkV2Shape,
) => {
  const inspect = (only?: ThreadId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const owners = yield* sql<{ child: string; parent: string }>`SELECT DISTINCT
      json_extract(payload_json, '$.childThreadId') AS child, thread_id AS parent
      FROM orchestration_v2_projection_subagents
      WHERE json_extract(payload_json, '$.origin') = 'app_owned'
        AND json_extract(payload_json, '$.childThreadId') IS NOT NULL
        AND (${only ?? null} IS NULL OR json_extract(payload_json, '$.childThreadId') = ${only ?? null})
      ORDER BY child, parent`;
        const metadata = new Map((yield* listMetadata(sql)).map((row) => [row.threadId, row]));
        const changes = [];
        const review = [];
        for (const owner of owners) {
          const threadId = ThreadId.make(owner.child);
          const parentThreadId = ThreadId.make(owner.parent);
          const shell = yield* store.getThreadShell(threadId);
          const parent = yield* store.getThreadShell(parentThreadId);
          if (
            !shell ||
            !parent ||
            shell.archivedAt ||
            shell.deletedAt ||
            parent.archivedAt ||
            parent.deletedAt ||
            shell.lineage.parentThreadId !== parentThreadId ||
            owners.some((row) => row.child === owner.child && row.parent !== owner.parent)
          ) {
            review.push({
              threadId,
              parentThreadId,
              reason: "Missing/archived owner or ambiguous execution ancestry.",
            });
            continue;
          }
          const history = Array.from(yield* Stream.runCollect(events.read({ threadId })));
          const created = history.find((stored) => stored.event.type === "thread.created");
          if (!created || created.event.type !== "thread.created") {
            review.push({
              threadId,
              parentThreadId,
              reason: "Creation provenance is unavailable.",
            });
            continue;
          }
          const originalThread = created.event.payload;
          const parentHistory = Array.from(
            yield* Stream.runCollect(
              events.read({ threadId: parentThreadId, throughSequence: created.sequence - 1 }),
            ),
          );
          const inheritedFrom = parentHistory
            .map(threadPayload)
            .findLast((thread) => thread !== null);
          const thread = yield* store.getThread(threadId);
          const reset = fields.filter((field) => {
            const original = scalar(originalThread[field]);
            return (
              original !== null &&
              inheritedFrom !== undefined &&
              original === scalar(inheritedFrom[field]) &&
              original === scalar(thread[field]) &&
              !history.some(
                (stored) =>
                  stored.sequence > created.sequence &&
                  deliberate[field].includes(stored.event.type),
              )
            );
          });
          const organization = metadata.get(threadId);
          if (reset.length || organization === undefined)
            changes.push({
              threadId,
              parentThreadId,
              creationEventId: created.event.id,
              expectedSequence: yield* events.latestSequence({ threadId }),
              organization:
                organization === undefined
                  ? {
                      before: null,
                      after: {
                        threadId,
                        parentThreadId,
                        remoteParent: null,
                        subproject: "off" as const,
                        settleOnComplete: true,
                      },
                    }
                  : null,
              fields: reset.map((field) => ({ field, before: scalar(thread[field]), after: null })),
            });
        }
        return { version: 1, changes, review };
      }),
    );
  const commitThread = (
    commandId: CommandId,
    threadId: ThreadId,
    update: (thread: OrchestrationV2AppThread) => OrchestrationV2AppThread,
  ) =>
    Effect.gen(function* () {
      const expectedThreadSequence = yield* events.latestSequence({ threadId });
      const thread = yield* store.getThread(threadId);
      const now = yield* DateTime.now;
      const result = yield* sink.commitCommand({
        commandId,
        threadId,
        commandType: "fork.delegated-workers.repair.v1",
        expectedThreadSequence,
        acceptedAt: now,
        effects: [],
        events: [
          {
            id: EventId.make(`${commandId}:event`),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: now,
            payload: update(thread),
          },
        ],
      });
      if (result.receipt.status !== "accepted")
        return yield* Effect.fail(
          new DelegatedWorkerRepairWriteRejectedError({
            commandId,
            threadId,
            reason: result.receipt.error ?? null,
          }),
        );
      return result;
    });
  const apply = () =>
    Effect.gen(function* () {
      const manifest = yield* inspect();
      const applied = [];
      const nesting = yield* makeNestingService(sql, store.getThreadShell, (command) =>
        commitThread(command.commandId, command.threadId, (thread) => ({
          ...thread,
          forkMetadataRevision: (thread.forkMetadataRevision ?? 0) + 1,
        })),
      );
      for (const planned of manifest.changes) {
        // Re-audit each candidate. A resumed repair preserves every later organizational or pin edit.
        const fresh = (yield* inspect(planned.threadId)).changes[0];
        if (!fresh) continue;
        const key = `fork:repair-delegates:v1:${fresh.creationEventId}`;
        if (fresh.organization !== null)
          yield* nesting.update({
            commandId: CommandId.make(`${key}:nest`),
            ...fresh.organization.after,
          });
        if (fresh.fields.length) {
          yield* commitThread(CommandId.make(`${key}:state`), fresh.threadId, (thread) => {
            const corrected = { ...thread };
            for (const { field } of fresh.fields) corrected[field] = null;
            return corrected;
          });
        }
        applied.push(fresh.threadId);
      }
      return { ...manifest, applied, remaining: yield* inspect() };
    });
  return { inspect, apply };
};

const make = Effect.gen(function* () {
  return DelegatedWorkerRepair.of(
    makeDelegatedWorkerRepair(
      yield* SqlClient.SqlClient,
      yield* ProjectionStore.ProjectionStoreV2,
      yield* EventStore.EventStoreV2,
      yield* EventSink.EventSinkV2,
    ),
  );
});
export const layer = Layer.effect(DelegatedWorkerRepair, make);
