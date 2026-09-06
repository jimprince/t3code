// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import * as ServerConfig from "../config.ts";
import { ThreadId } from "@t3tools/contracts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { decodeHistoricalAttachments } from "./AttachmentDecoder.ts";
import { makeHistoricalAttachmentRecovery } from "./AttachmentImport.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
describe("historical attachment import", () => {
  it("isolates malformed known types and retains DOCX, ZIP, image and future members", () => {
    const file = {
      type: "file",
      id: "docx",
      name: "a.docx",
      mimeType: "application/octet-stream",
      sizeBytes: 3,
    };
    const image = {
      type: "image",
      id: "image",
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 3,
    };
    expect(
      decodeHistoricalAttachments(
        encodeJson([
          file,
          { ...file, id: "zip", name: "a.zip" },
          image,
          { ...file, type: "future", id: "future" },
          { ...image, id: "bad", sizeBytes: -1 },
        ]),
      ).map((a) => a.id),
    ).toEqual(["docx", "zip", "image", "future"]);
  });
  it.effect(
    "recovers lazily, preserves source bytes, deduplicates and retries after restart",
    () => {
      const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
        prefix: "legacy-attachment-import-",
      });
      const stores = Layer.mergeAll(SqlitePersistenceMemory, configLayer).pipe(
        Layer.provideMerge(NodeServices.layer),
      );
      const eventStores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
        Layer.provideMerge(stores),
      );
      const sink = EventSink.layer.pipe(Layer.provideMerge(eventStores));
      const testLayer = LegacyV1ThreadImporter.layer.pipe(Layer.provideMerge(sink));
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const config = yield* ServerConfig.ServerConfig;
        const recoverHistoricalAttachmentRows = yield* makeHistoricalAttachmentRecovery;
        const source = NodePath.join(config.attachmentsDir, "old-upload.tmp");
        const bytes = Buffer.from([0, 255, 128]);
        yield* Effect.promise(() => NodeFSP.mkdir(config.attachmentsDir, { recursive: true }));
        yield* Effect.promise(() => NodeFSP.writeFile(source, bytes));
        const legacy = {
          type: "file",
          id: "old-docx",
          name: "a.docx",
          mimeType: "application/octet-stream",
          sizeBytes: 3,
          path: source,
        };
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('p', 'P', '/tmp', '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode, created_at, updated_at) VALUES ('t', 'p', 'T', '{"instanceId":"codex","model":"gpt-6.1-sol"}', 'full-access', 'default', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text, attachments_json, file_attachments_json, is_streaming, created_at, updated_at) VALUES ('m', 't', 'user', 'files', '[]', ${encodeJson([legacy, { ...legacy, id: "missing", name: "gone.zip", path: source + "-missing" }, { type: "file", id: "bad" }])}, 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
        const rows = [{ message_id: "m", thread_id: "t", attachments_json: "[]" }];
        const rename = vi.mocked(NodeFSP.rename).mockRejectedValueOnce(new Error("disk failure"));
        const failed = yield* recoverHistoricalAttachmentRows(rows);
        rename.mockClear();
        expect(decodeHistoricalAttachments(failed[0]!.attachments_json).map((a) => a.type)).toEqual(
          ["legacy-missing", "legacy-missing"],
        );
        expect(
          (yield* Effect.promise(() => NodeFSP.readdir(config.attachmentsDir))).filter((name) =>
            name.endsWith(".part"),
          ),
        ).toEqual([]);
        expect(yield* Effect.promise(() => NodeFSP.readFile(source))).toEqual(bytes);
        const first = yield* recoverHistoricalAttachmentRows(rows);
        const attachments = decodeHistoricalAttachments(first[0]!.attachments_json);
        expect(attachments.map((a) => a.type)).toEqual(["file", "legacy-missing"]);
        const destination = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment: attachments[0]!,
        });
        expect(destination).not.toBe(source);
        expect(yield* Effect.promise(() => NodeFSP.readFile(destination!))).toEqual(bytes);
        expect(yield* Effect.promise(() => NodeFSP.readFile(source))).toEqual(bytes);
        const restartedRecovery = yield* makeHistoricalAttachmentRecovery;
        expect(yield* restartedRecovery(rows)).toEqual(first);
        const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* importer.reconcileShells;
        yield* importer.ensureTranscript(ThreadId.make("t"));
        const projection = yield* projections.getThreadProjection(ThreadId.make("t"));
        expect(projection.messages[0]!.attachments).toEqual(attachments);
        expect(yield* importer.ensureTranscript(ThreadId.make("t"))).toMatchObject({
          importedMessageCount: 0,
        });
        expect(yield* Effect.promise(() => NodeFSP.readFile(source))).toEqual(bytes);
        yield* sql`UPDATE projection_thread_messages SET attachments_json = ${encodeJson([legacy])}, file_attachments_json = ${encodeJson([legacy])} WHERE message_id = 'm'`;
        const combined = yield* recoverHistoricalAttachmentRows([
          { ...rows[0]!, attachments_json: encodeJson([legacy]) },
        ]);
        expect(decodeHistoricalAttachments(combined[0]!.attachments_json)).toHaveLength(1);
      }).pipe(Effect.provide(testLayer), Effect.scoped);
    },
  );
});
