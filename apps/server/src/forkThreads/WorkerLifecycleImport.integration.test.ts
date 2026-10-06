import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { initializeMetadata, listMetadata } from "./MetadataStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
if (fixtures) {
  it.effect.each(["dev-vm", "local-mbp", "synthetic-edges"])(
    "preserves lifecycle, organizational nesting and ordering in copied %s state",
    (name) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-lifecycle-import-" });
        const copy = path.join(temporary, "state.sqlite");
        yield* fs.copyFile(path.join(fixtures, `${name}.small.sanitized.sqlite`), copy);
        const database = makeSqlitePersistenceLive(copy).pipe(Layer.provide(NodeServices.layer));
        const stores = Layer.mergeAll(
          database,
          EventStore.layer.pipe(Layer.provide(database)),
          ProjectionStore.layer.pipe(Layer.provide(database)),
        );
        const sink = EventSink.layer.pipe(Layer.provide(stores));
        const importer = LegacyV1ThreadImporter.layer.pipe(
          Layer.provide(Layer.mergeAll(stores, sink)),
        );
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const before = yield* sql<{
            thread_id: string;
            project_id: string;
            updated_at: string;
            settled_at: string | null;
            pinned_at: string | null;
            parent_thread_id: string | null;
            settle_on_complete: number | null;
            settled_override: string | null;
            pin_order_key: string | null;
            active_order_key: string | null;
            auto_settle_disabled_at: string | null;
          }>`SELECT thread_id, project_id, updated_at, settled_at, pinned_at, parent_thread_id, settle_on_complete, settled_override, pin_order_key, active_order_key, auto_settle_disabled_at FROM projection_threads WHERE deleted_at IS NULL`;
          yield* importer.reconcileShells;
          yield* initializeMetadata(sql);
          const metadataByThread = new Map(
            (yield* listMetadata(sql)).map((metadata) => [metadata.threadId, metadata]),
          );
          const mismatches: Array<{
            threadId: string;
            field: string;
            expected: unknown;
            actual: unknown;
          }> = [];
          const compare = (threadId: string, field: string, actual: unknown, expected: unknown) => {
            if (actual !== expected) mismatches.push({ threadId, field, actual, expected });
          };
          for (const row of before) {
            const native = (yield* projections.getThreadProjection(ThreadId.make(row.thread_id)))
              .thread;
            compare(row.thread_id, "projectId", native.projectId, row.project_id);
            compare(
              row.thread_id,
              "updatedAt",
              DateTime.toEpochMillis(native.updatedAt),
              Date.parse(row.updated_at),
            );
            compare(
              row.thread_id,
              "settledAt",
              native.settledAt == null ? null : DateTime.toEpochMillis(native.settledAt),
              row.settled_at == null ? null : Date.parse(row.settled_at),
            );
            compare(
              row.thread_id,
              "pinnedAt",
              native.pinnedAt == null ? null : DateTime.toEpochMillis(native.pinnedAt),
              row.pinned_at == null ? null : Date.parse(row.pinned_at),
            );
            compare(
              row.thread_id,
              "organizationalParentThreadId",
              metadataByThread.get(ThreadId.make(row.thread_id))?.parentThreadId,
              row.parent_thread_id,
            );
            compare(row.thread_id, "nativeParentThreadId", native.lineage.parentThreadId, null);
            compare(
              row.thread_id,
              "settleOnComplete",
              metadataByThread.get(ThreadId.make(row.thread_id))?.settleOnComplete ?? null,
              row.settle_on_complete == null ? null : row.settle_on_complete === 1,
            );
            compare(row.thread_id, "settledOverride", native.settledOverride, row.settled_override);
            compare(row.thread_id, "pinOrderKey", native.pinOrderKey ?? null, row.pin_order_key);
            compare(
              row.thread_id,
              "activeOrderKey",
              native.activeOrderKey ?? null,
              row.active_order_key,
            );
            compare(
              row.thread_id,
              "autoSettleDisabledAt",
              native.autoSettleDisabledAt == null,
              row.auto_settle_disabled_at == null,
            );
          }
          assert.deepEqual(mismatches, []);
          const again = yield* importer.reconcileShells;
          assert.equal(again.importedThreadCount, 0);
        }).pipe(Effect.provide(Layer.mergeAll(stores, sink, importer)));
      }).pipe(Effect.provide(NodeServices.layer)),
  );
}

if (!fixtures)
  it.effect.skip("copied-state fixtures require T3_LIFECYCLE_FIXTURES", () => Effect.void);
