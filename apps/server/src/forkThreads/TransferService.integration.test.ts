// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  ComposerContextId,
  FileContextRecord,
  MessageId,
  ProjectId,
  ThreadId,
  ThreadMoveBundle,
  ChatAttachmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FileSystem from "effect/FileSystem";
import {
  v2Projection,
  v2Now,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import * as Config from "../config.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Portable from "./PortableHistory.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Transfer from "./TransferService.ts";
import * as Workspace from "./TransferWorkspace.ts";
import * as Attachments from "./TransferAttachments.ts";
import {
  initializeTransferHistory,
  readTransferHistory,
  writeTransferHistory,
} from "./TransferHistoryStore.ts";
import { initializeMetadata, writeMetadata, listMetadata } from "./MetadataStore.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";

import { portable, persisted, threads, projects } from "./ForkService.testkit.ts";
const workspace = Layer.succeed(
  Workspace.TransferWorkspace,
  Workspace.TransferWorkspace.of({
    export: () => Effect.succeed({ git: null, warnings: [] }),
    import: () => Effect.succeed({ branch: null, worktreePath: null, cleanup: Effect.void }),
  }),
);
const config = Config.layerTest(process.cwd(), { prefix: "t3-transfer-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const attachments = Attachments.layer.pipe(Layer.provideMerge(config));
const dependencies = Layer.mergeAll(
  portable,
  threads,
  projects,
  workspace,
  attachments,
  Threads.legacyHistoryLayer.pipe(Layer.provide(persisted)),
);
const live = Transfer.layer.pipe(Layer.provideMerge(dependencies));
const target = ProjectId.make("target-project");
const decodeFileContext = Schema.decodeUnknownSync(FileContextRecord);
const decodeBundle = Schema.decodeUnknownSync(ThreadMoveBundle);
const encodeBundle = Schema.encodeEffect(ThreadMoveBundle);
const encodeEvidenceJson = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
const encodeBundleJson = Schema.encodeEffect(Schema.fromJsonString(ThreadMoveBundle));
const oldBundle = (version: 1 | 2) =>
  decodeBundle({
    version,
    exportedAt: "2026-01-01T00:00:00Z",
    sourceProjectId: "source-project",
    sourceWorkspaceRoot: "/source",
    repositoryIdentity: null,
    git: null,
    providerSession: { resumeCursor: { sessionId: "old-provider" } },
    warnings: [],
    ...(version === 2 ? { attachments: [] } : {}),
    thread: {
      id: "source-thread",
      title: "Old thread",
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      messages: [
        {
          id: "legacy-message",
          role: "user",
          text: "Historical prompt",
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
          attachments: [],
        },
      ],
      goal: { objective: "Historical goal", status: "completed" },
      checkpoints: [{ checkpointRef: "legacy-checkpoint" }],
      activities: [{ kind: "tool", payload: { output: "Historical tool output" } }],
    },
  });

describe("durable thread transfer", () => {
  it.effect.each([1, 2] as const)(
    "imports released v%s losslessly, maps fresh context and deduplicates after service restart",
    (version) =>
      Effect.gen(function* () {
        const service = yield* Transfer.TransferService;
        const projections = yield* Projections.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const bundle = oldBundle(version);
        const first = yield* service.importThread({ projectId: target, bundle });
        assert.equal(first.durable, true);
        const imported = yield* projections.getThreadProjection(first.threadId);
        assert.equal(imported.messages[0]?.text, "Historical prompt");
        assert.equal(imported.thread.historyOrigin, "v1_import");
        assert.equal(imported.runs.length, 0);
        assert.equal(imported.providerThreads.length, 0);
        assert.equal(imported.checkpoints.length, 0);
        const evidence = yield* readTransferHistory(sql, first.threadId);
        assert.deepStrictEqual(evidence.legacyBundle, yield* encodeBundle(bundle));
        const second = yield* service.importThread({ projectId: target, bundle });
        const restarted = yield* service
          .importThread({ projectId: target, bundle })
          .pipe(Effect.provide(Transfer.layer));
        assert.deepStrictEqual(second, first);
        assert.deepStrictEqual(restarted, first);
        assert.equal((yield* projections.getThreadProjection(first.threadId)).messages.length, 1);
        const wrongProject = yield* Effect.result(
          service.importThread({ projectId: ProjectId.make("other"), bundle }),
        );
        assert.equal(wrongProject._tag, "Failure");
        const exported = yield* service.exportThread({ threadId: first.threadId });
        assert.equal(exported.bundle.version, 3);
        if (exported.bundle.version === 3)
          assert.deepStrictEqual(exported.bundle.legacyBundle, evidence.legacyBundle);
      }).pipe(Effect.provide(live)),
  );
  it.effect(
    "keeps attachment bytes across native export/import, rewrites collisions and removes only newly owned failed objects",
    () =>
      Effect.gen(function* () {
        const service = yield* Transfer.TransferService;
        const history = yield* Portable.PortableHistory;
        const projections = yield* Projections.ProjectionStoreV2;
        const fs = yield* FileSystem.FileSystem;
        const config = yield* Config.ServerConfig;
        const bytes = new TextEncoder().encode("file bytes");
        const attachment = {
          type: "file" as const,
          id: ChatAttachmentId.make("source-11111111-1111-1111-1111-111111111111-txt"),
          name: "note.txt",
          mimeType: "text/plain",
          sizeBytes: bytes.length,
        };
        const source = ThreadId.make("source-native");
        yield* fs.writeFile(
          resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment })!,
          bytes,
        );
        yield* history.import({
          commandId: CommandId.make("seed-native"),
          thread: { ...v2Projection.thread, id: source },
          messages: [
            {
              id: MessageId.make("file-message"),
              threadId: source,
              runId: null,
              nodeId: null,
              role: "user",
              text: "Read the file",
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  {
                    version: 1,
                    kind: "file",
                    contextId: ComposerContextId.make("file-record"),
                    label: attachment.name,
                    attachmentId: attachment.id,
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    sizeBytes: attachment.sizeBytes,
                  },
                ],
              },
              streaming: false,
              createdAt: v2Now,
              updatedAt: v2Now,
              createdBy: "user",
              creationSource: "server",
            },
          ],
        });
        const exported = yield* service.exportThread({ threadId: source });
        const imported = yield* service.importThread({
          projectId: target,
          bundle: exported.bundle,
        });
        assert.notEqual(imported.threadId, source);
        const projection = yield* projections.getThreadProjection(imported.threadId);
        const copied = projection.messages[0]!.attachments[0]!;
        assert.notEqual(copied.id, attachment.id);
        assert.equal(
          decodeFileContext(projection.messages[0]!.context?.records[0]).attachmentId,
          copied.id,
        );
        assert.deepStrictEqual(
          yield* fs.readFile(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: copied })!,
          ),
          bytes,
        );
        assert.equal((yield* projections.getThreadProjection(source)).thread.archivedAt, null);
        const attachmentService = yield* Attachments.TransferAttachments;
        const invalid = yield* Effect.result(
          attachmentService.import(
            ThreadId.make("failure"),
            [attachment, { ...attachment, id: ChatAttachmentId.make("bad"), sizeBytes: 20 }],
            [
              { id: attachment.id, contentBase64: "ZmlsZSBieXRlcw==" },
              { id: ChatAttachmentId.make("bad"), contentBase64: "eA==" },
            ],
          ),
        );
        assert.equal(invalid._tag, "Failure");
        assert.deepStrictEqual(
          yield* fs.readFile(
            resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment: copied })!,
          ),
          bytes,
        );
      }).pipe(Effect.provide(live)),
  );
});

it.effect(
  "moves between two isolated databases without source archive or provider runtime copying",
  () =>
    Effect.gen(function* () {
      const bundle = yield* Effect.gen(function* () {
        const history = yield* Portable.PortableHistory;
        const service = yield* Transfer.TransferService;
        const id = ThreadId.make("isolated-source");
        yield* history.import({
          commandId: CommandId.make("isolated-seed"),
          thread: { ...v2Projection.thread, id },
          messages: [
            {
              id: MessageId.make("isolated-message"),
              threadId: id,
              role: "assistant",
              text: "Durable source context",
              runId: null,
              nodeId: null,
              attachments: [],
              streaming: false,
              createdBy: "system",
              creationSource: "server",
              createdAt: v2Now,
              updatedAt: v2Now,
            },
          ],
        });
        const sql = yield* SqlClient.SqlClient;
        yield* initializeMetadata(sql);
        yield* writeMetadata(sql, {
          threadId: id,
          parentThreadId: null,
          scope: "fixture-scope",
          settleOnComplete: false,
          remoteParent: {
            environmentId: "fixture-environment",
            threadId: ThreadId.make("fixture-supervisor"),
          },
        });
        yield* initializeTransferHistory(sql);
        yield* writeTransferHistory(sql, id, {
          nativeProjection: {
            thread: { id: "first-machine" },
            turnItems: [{ type: "tool_call", output: "first machine tool output" }],
            checkpoints: [{ id: "first-machine-checkpoint" }],
          },
          sourceMetadata: { scope: "first machine scope" },
        });
        return (yield* service.exportThread({ threadId: id })).bundle;
      }).pipe(Effect.provide(live));
      const secondBundle = yield* Effect.gen(function* () {
        const service = yield* Transfer.TransferService;
        const projections = yield* Projections.ProjectionStoreV2;
        const receipt = yield* service.importThread({ projectId: target, bundle });
        assert.equal(receipt.threadId, "isolated-source");
        assert.deepStrictEqual(yield* service.importThread({ projectId: target, bundle }), receipt);
        const targetThread = yield* projections.getThreadProjection(receipt.threadId);
        assert.equal(targetThread.messages[0]?.text, "Durable source context");
        assert.equal(targetThread.providerSessions.length, 0);
        assert.equal(targetThread.providerThreads.length, 0);
        assert.equal(targetThread.checkpoints.length, 0);
        const metadata = (yield* listMetadata(yield* SqlClient.SqlClient)).find(
          (row) => row.threadId === receipt.threadId,
        );
        assert.equal(metadata?.scope, "fixture-scope");
        assert.equal(metadata?.settleOnComplete, false);
        assert.deepStrictEqual(metadata?.remoteParent, {
          environmentId: "fixture-environment",
          threadId: "fixture-supervisor",
        });
        return (yield* service.exportThread({ threadId: receipt.threadId })).bundle;
      }).pipe(Effect.provide(live));
      yield* Effect.gen(function* () {
        const service = yield* Transfer.TransferService;
        const imported = yield* service.importThread({ projectId: target, bundle: secondBundle });
        const evidence = yield* readTransferHistory(yield* SqlClient.SqlClient, imported.threadId);
        assert.equal(
          Array.isArray(evidence.previousTransfers) ? evidence.previousTransfers.length : 0,
          2,
        );
        const encoded = yield* encodeEvidenceJson(evidence);
        assert.include(encoded, "first machine tool output");
        assert.include(encoded, "first-machine-checkpoint");
        assert.include(encoded, "first machine scope");
      }).pipe(Effect.provide(live));
    }),
);

it.effect("rejects an unrelated deterministic destination without overwriting its history", () =>
  Effect.gen(function* () {
    const service = yield* Transfer.TransferService;
    const history = yield* Portable.PortableHistory;
    const sql = yield* SqlClient.SqlClient;
    const bundle = oldBundle(2);
    const key = NodeCrypto.createHash("sha256")
      .update(yield* encodeBundleJson(bundle))
      .digest("hex");
    const destination = ThreadId.make(`move-${key.slice(0, 32)}`);
    for (const id of [ThreadId.make("source-thread"), destination])
      yield* history.import({
        commandId: CommandId.make(`unrelated:${id}`),
        thread: { ...v2Projection.thread, id },
        messages: [],
      });
    yield* initializeTransferHistory(sql);
    yield* writeTransferHistory(sql, destination, { unrelated: "retained evidence" });
    const failed = yield* Effect.result(service.importThread({ projectId: target, bundle }));
    assert.equal(failed._tag, "Failure");
    assert.deepStrictEqual(yield* readTransferHistory(sql, destination), {
      unrelated: "retained evidence",
    });
    const projection = yield* Projections.ProjectionStoreV2;
    assert.equal((yield* projection.getThreadProjection(destination)).messages.length, 0);
  }).pipe(Effect.provide(live)),
);
