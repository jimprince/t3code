import * as NodeCrypto from "node:crypto";
import { stableStringify } from "@t3tools/shared/relaySigning";
import {
  CommandId,
  MessageId,
  RunId,
  HandoffAcceptInput,
  HandoffReceipt,
  HandoffError,
  HandoffLookupInput,
  HandoffLookupResult,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/unstable/sql/SqlClient";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import { MessageAdmission, type Admission } from "./MessageAdmission.ts";
import { readWorkerMetadata } from "./WorkerLifecycleMetadata.ts";

const isHandoffError = Schema.is(HandoffError);

const storedSchema = Schema.Struct({
  subject: Schema.String,
  binding: Schema.String,
  coalesceKey: Schema.NullOr(Schema.String),
  senderThreadId: Schema.NullOr(Schema.String),
  receipt: HandoffReceipt,
  pendingInput: Schema.optional(HandoffAcceptInput),
});
type Stored = typeof storedSchema.Type;
const codec = Schema.fromJsonString(storedSchema);
const decode = Schema.decodeUnknownEffect(codec);
const encode = Schema.encodeEffect(codec);
const inboxCodec = Schema.fromJsonString(
  Schema.Struct({
    ids: Schema.Array(Schema.String).check(Schema.isMaxLength(50)),
    truncated: Schema.Boolean,
  }),
);
const decodeInbox = Schema.decodeUnknownEffect(inboxCodec);
const encodeInbox = Schema.encodeEffect(inboxCodec);
const inboxKey = (threadId: string) => `handoff-inbox:${threadId}`;
const key = (sendId: string) => `handoff:${sendId}`;

/** Uses the existing sidecar receipt table; native events/outbox remain the delivery journal. */
export const makeHandoffService = (
  sql: SqlClient.SqlClient,
  threads: ThreadManagementServiceShape,
  providers: Effect.Effect<ReadonlyArray<ServerProvider>>,
  subject: string,
) => {
  const load = (sendId: string) =>
    sql<{
      payload: string;
    }>`SELECT json_remove(payload,'$.pendingInput') AS payload FROM fork_thread_metadata_receipts WHERE command_id = ${key(sendId)}`.pipe(
      Effect.flatMap((rows) => (rows[0] ? decode(rows[0].payload) : Effect.succeed(null))),
    );
  const save = Effect.fnUntraced(function* (value: Stored) {
    const payload = yield* encode(value);
    yield* sql`INSERT INTO fork_thread_metadata_receipts (command_id,payload) VALUES (${key(value.receipt.sendId)},${payload}) ON CONFLICT(command_id) DO UPDATE SET payload=excluded.payload`;
    // Exact-key bounded inbox index uses the existing receipt table, with no
    // JSON scan across the server's full receipt history.
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM fork_thread_metadata_receipts WHERE command_id=${inboxKey(value.receipt.recipientThreadId)}`;
    const previous = rows[0]
      ? yield* decodeInbox(rows[0].payload)
      : { ids: [] as string[], truncated: false };
    if (!previous.ids.includes(value.receipt.sendId)) {
      const all = [value.receipt.sendId, ...previous.ids];
      const index = yield* encodeInbox({
        ids: all.slice(0, 50),
        truncated: previous.truncated || all.length > 50,
      });
      yield* sql`INSERT INTO fork_thread_metadata_receipts (command_id,payload) VALUES (${inboxKey(value.receipt.recipientThreadId)},${index}) ON CONFLICT(command_id) DO UPDATE SET payload=excluded.payload`;
    }
  });
  const supersedeHeld = Effect.fnUntraced(function* (input: HandoffAcceptInput) {
    if (input.coalesceKey === null) return;
    const rows = yield* sql<{
      payload: string;
    }>`SELECT json_remove(payload,'$.pendingInput') AS payload FROM fork_thread_metadata_receipts WHERE command_id LIKE 'handoff:%' AND json_extract(payload,'$.subject')=${subject} AND json_extract(payload,'$.senderThreadId') IS ${input.senderThreadId ?? null} AND json_extract(payload,'$.coalesceKey')=${input.coalesceKey} AND json_extract(payload,'$.receipt.recipientThreadId')=${input.recipientThreadId} AND json_extract(payload,'$.receipt.status')='held' AND command_id<>${key(input.sendId)} LIMIT 50`;
    for (const row of rows) {
      const old = yield* decode(row.payload);
      yield* save({ ...old, receipt: { ...old.receipt, status: "superseded", cause: null } });
    }
  });
  const currentReceipt = Effect.fnUntraced(function* (stored: Stored) {
    if (stored.receipt.status !== "accepted" && stored.receipt.status !== "queued")
      return stored.receipt;
    const messageId = `${key(stored.receipt.sendId)}:message`;
    // Indexed exact message/run joins; no transcript or tool-body hydration.
    const rows = yield* sql<{
      status: string;
      initial_message: string;
    }>`SELECT json_extract(r.payload_json,'$.status') AS status,json_extract(r.payload_json,'$.userMessageId') AS initial_message FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_runs r ON r.run_id=json_extract(m.payload_json,'$.runId') WHERE m.message_id=${messageId} AND m.thread_id=${stored.receipt.recipientThreadId} LIMIT 1`;
    const row = rows[0];
    if (!row) return stored.receipt;
    if (row.initial_message === messageId && row.status === "cancelled")
      return { ...stored.receipt, status: "cancelled" as const, cause: "CANCELLED" as const };
    return {
      ...stored.receipt,
      status:
        row.status === "queued"
          ? ("queued" as const)
          : row.initial_message === messageId
            ? ("started" as const)
            : ("steered" as const),
    };
  });
  const accept = Effect.fnUntraced(function* (input: HandoffAcceptInput) {
    // Sender identity comes from authentication, not senderThreadId's display provenance.
    const binding = NodeCrypto.createHash("sha256")
      .update(
        stableStringify({
          subject,
          sendId: input.sendId,
          recipientThreadId: input.recipientThreadId,
          senderThreadId: input.senderThreadId ?? null,
          context: input.context ?? null,
          text: input.text,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          coalesceKey: input.coalesceKey,
          intent: input.intent,
          allowQueueFallback: input.allowQueueFallback ?? true,
        }),
      )
      .digest("hex");
    const commandId = CommandId.make(key(input.sendId));
    let saved: Stored | null = null;
    let conflict = false;
    const admission: Admission = {
      commandId,
      accept: Effect.gen(function* () {
        const old = yield* load(input.sendId);
        if (old && (old.subject !== subject || old.binding !== binding)) {
          conflict = true;
          return false;
        }
        if (
          !old &&
          (yield* sql`SELECT command_id FROM orchestration_command_receipts WHERE command_id=${commandId} LIMIT 1`)
            .length > 0
        ) {
          conflict = true;
          return false;
        }
        const now = yield* DateTime.now;
        // Exact retries of accepted native commands only read the receipt. A held send
        // may be explicitly retried after unsettle; transport never retries it by itself.
        if (old) {
          const receipt = yield* currentReceipt(old);
          if (receipt.status !== "held" && receipt.status !== "accepted") {
            saved = { ...old, receipt };
            return false;
          }
        }
        const shell = yield* threads.getThreadShell(input.recipientThreadId);
        const metadata = shell ? yield* readWorkerMetadata(sql, input.recipientThreadId) : null;
        const provider = shell
          ? (yield* providers).find((p) => p.instanceId === shell.modelSelection.instanceId)
          : undefined;
        const exhausted =
          provider?.usageLimits?.windows.some(
            (window) =>
              window.usedPercent >= 100 &&
              (!window.resetsAt || Date.parse(window.resetsAt) > DateTime.toEpochMillis(now)),
          ) ?? false;
        const records =
          shell && input.allowQueueFallback === false
            ? yield* threads.getThreadRecords(input.recipientThreadId, ["runs"])
            : null;
        const busy =
          records?.runs.some((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          ) ?? false;
        const cause = !shell
          ? ("NOT_FOUND" as const)
          : shell.archivedAt
            ? ("ARCHIVED" as const)
            : shell.settledOverride === "settled"
              ? ("SETTLED" as const)
              : exhausted
                ? ("QUOTA_EXHAUSTED" as const)
                : busy
                  ? ("BUSY" as const)
                  : null;
        saved = {
          subject,
          binding,
          coalesceKey: input.coalesceKey,
          senderThreadId: input.senderThreadId ?? null,
          ...(cause === "SETTLED" ? { pendingInput: input } : {}),
          receipt: {
            sendId: input.sendId,
            recipientThreadId: input.recipientThreadId,
            acceptedAt: old?.receipt.acceptedAt ?? DateTime.formatIso(now),
            status: cause === "SETTLED" ? "held" : cause ? "refused" : "accepted",
            cause,
            ownerThreadId: metadata?.parentThreadId ?? null,
          },
        };
        if (cause) {
          yield* sql.withTransaction(
            save(saved).pipe(
              Effect.andThen(cause === "SETTLED" ? supersedeHeld(input) : Effect.void),
            ),
          );
          return false;
        }
        return true;
      }).pipe(Effect.mapError(() => new HandoffError({ causeCode: "PERSISTENCE_FAILED" }))),
      // The native receipt, authenticated binding, events, projections and outbox
      // commit together. No accepted sidecar can outlive a rolled-back dispatch.
      persist: Effect.suspend(() =>
        saved ? save(saved) : Effect.die("Missing handoff admission"),
      ).pipe(Effect.mapError(() => new HandoffError({ causeCode: "PERSISTENCE_FAILED" }))),
      finish: (dispatchLocked) =>
        Effect.gen(function* () {
          yield* supersedeHeld(input);
          // Only this sender's still-queued progress is replaceable. Dispatched work
          // stays in history; it cannot be recalled or attributed to a new send ID.
          if (input.coalesceKey !== null) {
            const rows = yield* sql<{
              payload: string;
              run_id: string;
            }>`SELECT json_remove(s.payload,'$.pendingInput') AS payload,r.run_id FROM fork_thread_metadata_receipts s JOIN orchestration_v2_projection_messages m ON m.message_id=s.command_id||':message' JOIN orchestration_v2_projection_runs r ON r.run_id=json_extract(m.payload_json,'$.runId') WHERE s.command_id LIKE 'handoff:%' AND json_extract(s.payload,'$.subject')=${subject} AND json_extract(s.payload,'$.senderThreadId') IS ${input.senderThreadId ?? null} AND json_extract(s.payload,'$.coalesceKey')=${input.coalesceKey} AND m.thread_id=${input.recipientThreadId} AND r.status='queued' AND s.command_id<>${key(input.sendId)} LIMIT 50`;
            for (const row of rows) {
              const previous = yield* decode(row.payload);
              yield* dispatchLocked({
                type: "queued-run.cancel",
                commandId: CommandId.make(
                  `${key(input.sendId)}:supersede:${previous.receipt.sendId}`,
                ),
                threadId: input.recipientThreadId,
                runId: RunId.make(row.run_id),
              });
              yield* save({
                ...previous,
                receipt: { ...previous.receipt, status: "superseded", cause: null },
              });
            }
          }
        }).pipe(Effect.mapError(() => new HandoffError({ causeCode: "PERSISTENCE_FAILED" }))),
    };
    yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId,
        threadId: input.recipientThreadId,
        messageId: MessageId.make(`${key(input.sendId)}:message`),
        text: input.text,
        attachments: input.attachments ?? [],
        createdBy: input.intent === "control" ? "user" : "agent",
        creationSource: "server",
        ...(input.senderThreadId ? { senderThreadId: input.senderThreadId } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.intent === "queue"
          ? {}
          : {
              deliveryIntent: input.intent === "control" ? ("steer" as const) : ("auto" as const),
            }),
        dispatchMode: {
          type: input.intent === "queue" ? "queue_after_active" : "start_immediately",
        },
      })
      .pipe(
        Effect.provideService(MessageAdmission, admission),
        Effect.catchCause(() => Effect.fail(new HandoffError({ causeCode: "DISPATCH_REJECTED" }))),
      );
    if (conflict) return yield* new HandoffError({ causeCode: "SEND_ID_CONFLICT" });
    if (!saved) return yield* new HandoffError({ causeCode: "DISPATCH_REJECTED" });
    const latest = yield* load(input.sendId);
    const receipt = yield* currentReceipt(latest ?? saved);
    // Remove only the redundant transport body. Never overwrite a concurrent
    // supersession or held receipt after releasing the lifecycle lock.
    if (receipt.status !== "accepted" && receipt.status !== "held")
      yield* sql`UPDATE fork_thread_metadata_receipts SET payload=json_remove(payload,'$.pendingInput') WHERE command_id=${key(input.sendId)}`;
    return receipt;
  });
  const lookup = Effect.fnUntraced(function* (input: typeof HandoffLookupInput.Type) {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 30 }));
    let records: Stored[];
    if (input.type === "exact") {
      const record = yield* load(input.sendId);
      if (record && record.subject !== subject)
        return yield* new HandoffError({ causeCode: "ACCESS_DENIED" });
      records = record && record.receipt.acceptedAt >= cutoff ? [record] : [];
    } else {
      const since = Date.parse(input.since),
        until = Date.parse(input.until);
      if (
        !Number.isFinite(since) ||
        !Number.isFinite(until) ||
        until < since ||
        until - since > 86_400_000
      )
        return yield* new HandoffError({ causeCode: "DISPATCH_REJECTED" });
      const rows = yield* sql<{
        payload: string;
      }>`SELECT json_remove(payload,'$.pendingInput') AS payload FROM fork_thread_metadata_receipts WHERE command_id LIKE 'handoff:%' AND json_extract(payload,'$.subject')=${subject} AND json_extract(payload,'$.receipt.recipientThreadId')=${input.recipientThreadId} AND json_extract(payload,'$.coalesceKey')=${input.coalesceKey} AND json_extract(payload,'$.receipt.acceptedAt')>=${DateTime.formatIso(DateTime.makeUnsafe(since)) > cutoff ? DateTime.formatIso(DateTime.makeUnsafe(since)) : cutoff} AND json_extract(payload,'$.receipt.acceptedAt')<=${DateTime.formatIso(DateTime.makeUnsafe(until))} LIMIT 51`;
      records = yield* Effect.forEach(rows, (row) => decode(row.payload));
    }
    const receipts = yield* Effect.forEach(records.slice(0, 50), currentReceipt);
    return {
      state: receipts.length > 1 ? "multiple" : receipts.length ? "found" : "unknown",
      receipts,
      retentionDays: 30,
      truncated: records.length > 50,
    } satisfies typeof HandoffLookupResult.Type;
  });
  const inbox = Effect.fnUntraced(function* (threadId: ThreadId) {
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 30 }));
    const rows = yield* sql<{
      payload: string;
    }>`SELECT payload FROM fork_thread_metadata_receipts WHERE command_id=${inboxKey(threadId)}`;
    const index = rows[0] ? yield* decodeInbox(rows[0].payload) : { ids: [], truncated: false };
    const records = yield* Effect.forEach(index.ids, load);
    const receipts = yield* Effect.forEach(
      records.filter(
        (record): record is Stored => record !== null && record.receipt.acceptedAt >= cutoff,
      ),
      currentReceipt,
    );
    return {
      state: receipts.length ? "found" : "unknown",
      receipts,
      retentionDays: 30,
      truncated: index.truncated,
    } satisfies HandoffLookupResult;
  });
  const sanitize = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.catchCause((cause) => {
        const error = Cause.findErrorOption(cause);
        return Effect.fail(
          Option.isSome(error) && isHandoffError(error.value)
            ? error.value
            : new HandoffError({ causeCode: "PERSISTENCE_FAILED" }),
        );
      }),
    );
  return {
    accept: (input: HandoffAcceptInput) => sanitize(accept(input)),
    lookup: (input: typeof HandoffLookupInput.Type) => sanitize(lookup(input)),
    inbox: (threadId: ThreadId) => sanitize(inbox(threadId)),
  };
};
