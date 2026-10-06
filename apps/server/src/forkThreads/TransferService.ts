// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ThreadId,
  ThreadTransferError,
  ThreadMoveBundle,
  OrchestrationImportThreadResult,
  OrchestrationMessageContext,
  type OrchestrationImportThreadInput,
  type OrchestrationExportThreadInput,
  type OrchestrationExportThreadResult,
  type ForkThreadMetadata,
  ForkRemoteParent,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Portable from "./PortableHistory.ts";
import * as Workspace from "./TransferWorkspace.ts";
import * as Attachments from "./TransferAttachments.ts";
import {
  transferConversation,
  encodedProjection,
  rewriteTransferContext,
} from "./TransferCodec.ts";
import { initializeMetadata, listMetadata, writeMetadata } from "./MetadataStore.ts";
import {
  initializeTransferHistory,
  readTransferHistory,
  writeTransferHistory,
} from "./TransferHistoryStore.ts";

const receiptJson = Schema.fromJsonString(OrchestrationImportThreadResult);
const encodeBundle = Schema.encodeSync(ThreadMoveBundle);
const encodeBundleEffect = Schema.encodeEffect(ThreadMoveBundle);
const decodeContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const decodeRemoteParent = Schema.decodeUnknownOption(ForkRemoteParent);
const isTransferError = Schema.is(ThreadTransferError);
const preparedSchema = Schema.fromJsonString(
  Schema.Struct({
    branch: Schema.NullOr(Schema.String),
    worktreePath: Schema.NullOr(Schema.String),
  }),
);
const encodePrepared = Schema.encodeEffect(preparedSchema);
const decodePrepared = Schema.decodeUnknownEffect(preparedSchema);

const digest = (bundle: ThreadMoveBundle) =>
  NodeCrypto.createHash("sha256")
    .update(JSON.stringify(encodeBundle(bundle)))
    .digest("hex");
export class TransferService extends Context.Service<
  TransferService,
  {
    readonly exportThread: (
      input: OrchestrationExportThreadInput,
    ) => Effect.Effect<OrchestrationExportThreadResult, ThreadTransferError>;
    readonly importThread: (
      input: OrchestrationImportThreadInput,
    ) => Effect.Effect<OrchestrationImportThreadResult, ThreadTransferError>;
  }
>()("t3/forkThreads/TransferService") {}
const make = Effect.gen(function* () {
  const environment = yield* Effect.serviceOption(Environment.ServerEnvironment);
  const threads = yield* Threads.ThreadManagementService;
  const legacyHistory = yield* Threads.LegacyHistoryAccess;
  const projects = yield* Projects.ProjectService;
  const projections = yield* Projections.ProjectionStoreV2;
  const sink = yield* Sink.EventSinkV2;
  const receipts = yield* Receipts.CommandReceiptStoreV2;
  const history = yield* Portable.PortableHistory;
  const workspace = yield* Workspace.TransferWorkspace;
  const attachments = yield* Attachments.TransferAttachments;
  const sql = yield* SqlClient.SqlClient;
  const locks = yield* KeyedLock.make<string>();
  const initialize = Effect.gen(function* () {
    yield* initializeMetadata(sql);
    yield* initializeTransferHistory(sql);
    yield* sql`CREATE TABLE IF NOT EXISTS fork_thread_transfers (receipt TEXT PRIMARY KEY, project_id TEXT NOT NULL, thread_id TEXT NOT NULL, prepared TEXT, result TEXT)`;
  });
  const exportThread = Effect.fn("TransferService.exportThread")(function* (
    input: OrchestrationExportThreadInput,
  ) {
    yield* initialize;
    let projection = yield* threads.getThreadProjection(input.threadId);
    const active = projection.runs.find((run) =>
      ["running", "preparing", "queued", "waiting"].includes(run.status),
    );
    if (active) {
      const sequence = yield* sink.latestSequence({ threadId: input.threadId });
      yield* threads.interruptThread({
        commandId: CommandId.make(`transfer:interrupt:${active.id}`),
        projectId: projection.thread.projectId,
        threadId: input.threadId,
        runId: active.id,
        reason: "Moving thread to another environment.",
      });
      const current = yield* threads.getThreadRecords(input.threadId, ["runs"]);
      if (
        current.runs.some(
          (run) =>
            run.id === active.id &&
            ["running", "preparing", "queued", "waiting"].includes(run.status),
        )
      ) {
        yield* sink
          .stream({ threadId: input.threadId, afterSequence: sequence, eventType: "run.updated" })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "run.updated" &&
                stored.event.payload.id === active.id &&
                ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                  stored.event.payload.status,
                ),
            ),
            Stream.runHead,
          );
      }
      projection = yield* threads.getThreadProjection(input.threadId);
    }
    if (
      projection.runs.some((run) =>
        ["running", "preparing", "starting", "queued", "waiting"].includes(run.status),
      )
    )
      return yield* new ThreadTransferError({
        operation: "quiesce",
        cause: "Source has pending work; retry when stopped.",
      });
    const project = yield* projects.getById(projection.thread.projectId);
    if (Option.isNone(project))
      return yield* new ThreadTransferError({
        operation: "export",
        cause: "Source project missing.",
      });
    const warnings: Array<string> = [];
    const references = yield* Effect.try({
      try: () => Attachments.collectTransferAttachments(encodedProjection(projection)),
      catch: (cause) => new ThreadTransferError({ operation: "export-attachments", cause }),
    });
    const bytes = yield* attachments.export(references);
    const legacy = yield* legacyHistory.read(input.threadId);
    const oldCheckpoints = Array.isArray(legacy.legacyTurns)
      ? legacy.legacyTurns.flatMap((row) =>
          Predicate.isObject(row) && typeof row.checkpoint_ref === "string"
            ? [row.checkpoint_ref]
            : [],
        )
      : [];
    const workspaceExport = yield* workspace.export(
      projection.thread.worktreePath ?? project.value.workspaceRoot,
      projection.thread.branch,
      [...projection.checkpoints.map((checkpoint) => checkpoint.ref), ...oldCheckpoints],
    );
    const git = workspaceExport.git;
    if (project.value.kind !== "chat") warnings.push(...workspaceExport.warnings);
    const metadata = (yield* listMetadata(sql)).find((row) => row.threadId === input.threadId);
    const oldHistory = yield* readTransferHistory(sql, input.threadId);
    const legacyBundle = Predicate.isObject(oldHistory.legacyBundle)
      ? oldHistory.legacyBundle
      : null;
    return {
      bundle: {
        version: 3 as const,
        ...(Option.isSome(environment)
          ? { sourceEnvironmentId: String(yield* environment.value.getEnvironmentId) }
          : {}),
        exportedAt: DateTime.formatIso(yield* DateTime.now),
        sourceProjectId: projection.thread.projectId,
        sourceWorkspaceRoot: project.value.workspaceRoot,
        repositoryIdentity: project.value.repositoryIdentity
          ? { ...project.value.repositoryIdentity }
          : null,
        projection,
        metadata: metadata === undefined ? {} : { ...metadata },
        history: { ...oldHistory, ...legacy },
        legacyBundle,
        git,
        attachments: [...bytes],
        warnings,
      },
    };
  });
  const importThread = Effect.fn("TransferService.importThread")(function* (
    input: OrchestrationImportThreadInput,
  ) {
    yield* initialize;
    const key = digest(input.bundle);
    const existing = yield* sql<{
      project_id: string;
      thread_id: string;
      prepared: string | null;
      result: string | null;
    }>`SELECT * FROM fork_thread_transfers WHERE receipt = ${key}`;
    if (existing[0] && existing[0].project_id !== input.projectId)
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "A durable transfer already belongs to another project.",
      });
    if (existing[0]?.result) {
      const result = yield* Schema.decodeUnknownEffect(receiptJson)(existing[0].result);
      const shell = yield* projections.getThreadShell(result.threadId);
      if (shell === null || shell.projectId !== input.projectId)
        return yield* new ThreadTransferError({
          operation: "verify",
          cause: "Destination receipt has no durable thread.",
        });
      return result;
    }
    const project = yield* projects.getById(input.projectId);
    if (Option.isNone(project))
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "Destination project missing.",
      });
    if (
      input.bundle.repositoryIdentity &&
      project.value.repositoryIdentity &&
      input.bundle.repositoryIdentity.canonicalKey !== project.value.repositoryIdentity.canonicalKey
    )
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "Destination repository identity does not match the source.",
      });
    const conversation = yield* Effect.try({
      try: () => transferConversation(input.bundle),
      catch: (cause) => new ThreadTransferError({ operation: "decode", cause }),
    });
    if (project.value.kind === "chat" && input.bundle.git !== null)
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "General Chat cannot import a git workspace.",
      });
    const collision = yield* projections.getThreadShell(conversation.thread.id);
    const threadId = existing[0]
      ? ThreadId.make(existing[0].thread_id)
      : collision === null
        ? conversation.thread.id
        : ThreadId.make(`move-${key.slice(0, 32)}`);
    const commandId = CommandId.make(`transfer:${key}`);
    const committed = yield* receipts.getByCommandId(commandId);
    if (
      Option.isSome(committed) &&
      (committed.value.threadId !== threadId ||
        committed.value.status !== "accepted" ||
        committed.value.commandType !== "fork.history.import")
    )
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "Transfer command receipt belongs to another operation.",
      });
    if (Option.isNone(committed) && (yield* projections.getThreadShell(threadId)) !== null)
      return yield* new ThreadTransferError({
        operation: "import",
        cause: "Transfer destination identity belongs to another thread.",
      });
    if (!existing[0])
      yield* sql`INSERT INTO fork_thread_transfers VALUES (${key}, ${input.projectId}, ${threadId}, NULL, NULL)`;
    let prepared: { branch: string | null; worktreePath: string | null };
    let cleanupWorkspace: Effect.Effect<void> = Effect.void;
    if (existing[0]?.prepared) {
      prepared = yield* decodePrepared(existing[0].prepared);
    } else {
      const importedWorkspace = yield* workspace.import({
        cwd: project.value.workspaceRoot,
        git: input.bundle.git,
        key,
        threadId,
        branchConflict: input.branchConflict ?? "fail",
      });
      prepared = { branch: importedWorkspace.branch, worktreePath: importedWorkspace.worktreePath };
      cleanupWorkspace = importedWorkspace.cleanup;
      const preparedJson = yield* encodePrepared(prepared);
      yield* sql`UPDATE fork_thread_transfers SET prepared = ${preparedJson} WHERE receipt = ${key}`;
    }
    const references = yield* Effect.try({
      try: () =>
        Attachments.collectTransferAttachments(
          input.bundle.version === 3
            ? encodedProjection(input.bundle.projection)
            : [conversation.messages, input.bundle.thread],
        ),
      catch: (cause) => new ThreadTransferError({ operation: "import-attachments", cause }),
    });
    const suppliedBytes = input.bundle.version === 1 ? [] : input.bundle.attachments;
    const importedAttachments = yield* attachments.import(threadId, references, suppliedBytes).pipe(
      Effect.onError(() =>
        Effect.gen(function* () {
          yield* cleanupWorkspace;
          if (!existing[0]?.prepared)
            yield* sql`UPDATE fork_thread_transfers SET prepared = NULL WHERE receipt = ${key}`;
        }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
    const destinationRoot = prepared.worktreePath ?? project.value.workspaceRoot;
    const messages = conversation.messages.map((message) => ({
      ...message,
      attachments: message.attachments.map(
        (attachment) => importedAttachments.attachments.get(attachment.id) ?? attachment,
      ),
      ...(message.context === undefined
        ? {}
        : {
            context: decodeContext(
              rewriteTransferContext(
                message.context,
                input.bundle.sourceWorkspaceRoot,
                destinationRoot,
                importedAttachments.attachments,
              ),
            ),
          }),
    }));
    const warnings = [...input.bundle.warnings, ...importedAttachments.warnings];
    if (input.bundle.version !== 3 && input.bundle.providerSession !== null)
      warnings.push("Provider context will continue through a fresh bounded transcript handoff.");
    const evidence =
      input.bundle.version === 3
        ? {
            ...input.bundle.history,
            previousTransfers: [
              ...(Array.isArray(input.bundle.history.previousTransfers)
                ? input.bundle.history.previousTransfers
                : []),
              ...(Predicate.isObject(input.bundle.history.nativeProjection)
                ? [
                    {
                      nativeProjection: input.bundle.history.nativeProjection,
                      ...(input.bundle.history.sourceMetadata === undefined
                        ? {}
                        : { sourceMetadata: input.bundle.history.sourceMetadata }),
                      ...(input.bundle.history.attachmentMap === undefined
                        ? {}
                        : { attachmentMap: input.bundle.history.attachmentMap }),
                    },
                  ]
                : []),
            ],
            nativeProjection: encodedProjection(input.bundle.projection),
            sourceMetadata: input.bundle.metadata,
            legacyBundle: input.bundle.legacyBundle,
          }
        : { legacyBundle: yield* encodeBundleEffect(input.bundle) };
    Object.assign(evidence, { attachmentMap: Object.fromEntries(importedAttachments.attachments) });
    const sourceMetadata = input.bundle.version === 3 ? input.bundle.metadata : {};
    const remote = decodeRemoteParent(sourceMetadata.remoteParent);
    const sourceParent =
      input.bundle.version === 3 &&
      input.bundle.sourceEnvironmentId &&
      typeof sourceMetadata.parentThreadId === "string"
        ? {
            environmentId: input.bundle.sourceEnvironmentId,
            threadId: ThreadId.make(sourceMetadata.parentThreadId),
          }
        : null;
    const metadata: ForkThreadMetadata = {
      threadId,
      parentThreadId: null,
      ...(Option.isSome(remote)
        ? { remoteParent: remote.value }
        : sourceParent
          ? { remoteParent: sourceParent }
          : {}),
      ...(typeof sourceMetadata.scope === "string" || sourceMetadata.scope === null
        ? { scope: sourceMetadata.scope }
        : {}),
      ...(typeof sourceMetadata.settleOnComplete === "boolean" ||
      sourceMetadata.settleOnComplete === null
        ? { settleOnComplete: sourceMetadata.settleOnComplete }
        : {}),
    };
    yield* Effect.gen(function* () {
      yield* writeTransferHistory(sql, threadId, evidence);
      yield* writeMetadata(sql, metadata);
      yield* history.import({
        commandId,
        messages,
        thread: {
          ...conversation.thread,
          id: threadId,
          projectId: input.projectId,
          branch: prepared.branch,
          worktreePath: prepared.worktreePath,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          forkedFrom: null,
          lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
          archivedAt: null,
          deletedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
        },
      });
    }).pipe(
      Effect.onError(() =>
        Option.isSome(committed)
          ? Effect.void
          : Effect.gen(function* () {
              // Re-read the native receipt: a lost reply can follow a successful commit.
              if (Option.isSome(yield* receipts.getByCommandId(commandId))) return;
              yield* importedAttachments.cleanup;
              yield* cleanupWorkspace;
              yield* sql`DELETE FROM fork_transferred_history WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM fork_thread_metadata WHERE thread_id = ${threadId}`;
              yield* sql`DELETE FROM fork_thread_transfers WHERE receipt = ${key}`;
            }).pipe(Effect.catch(() => Effect.void)),
      ),
    );
    const durable = yield* projections.getThreadProjection(threadId);
    if (durable.messages.length !== messages.length)
      return yield* new ThreadTransferError({
        operation: "verify",
        cause: "Destination transcript was not durably committed.",
      });
    const result: OrchestrationImportThreadResult = {
      threadId,
      worktreePath: prepared.worktreePath,
      warnings,
      receipt: key,
      durable: true,
    };
    const encoded = yield* Schema.encodeEffect(receiptJson)(result);
    yield* sql`UPDATE fork_thread_transfers SET result = ${encoded} WHERE receipt = ${key}`;
    // Read the receipt back before the caller may archive the source.
    const stored = yield* sql<{
      result: string;
    }>`SELECT result FROM fork_thread_transfers WHERE receipt = ${key}`;
    return yield* Schema.decodeUnknownEffect(receiptJson)(stored[0]!.result);
  });
  const error = (operation: string) => (cause: unknown) =>
    isTransferError(cause) ? cause : new ThreadTransferError({ operation, cause });
  return TransferService.of({
    exportThread: (input) =>
      locks
        .withLock(`export:${input.threadId}`, exportThread(input))
        .pipe(Effect.mapError(error("export"))),
    importThread: (input) =>
      locks.withLock("import", importThread(input)).pipe(Effect.mapError(error("import"))),
  });
});
export const layer = Layer.effect(TransferService, make);
