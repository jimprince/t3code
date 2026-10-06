import { assert, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as NodeSqlite from "node:sqlite";
import { isPageAgentThreadId, ThreadId, withoutPageAgentThreads } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";

const fixtures = process.env.T3_LIFECYCLE_FIXTURES;
if (fixtures) {
  it.effect("imports a V1 page-agent thread under its own id from a copied database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "t3-page-agent-import-" });
      const copy = path.join(temporary, "state.sqlite");
      yield* fs.copyFile(path.join(fixtures, "local-mbp.small.sanitized.sqlite"), copy);
      // Only the threads-projects extract carries a page-agent row; it has no
      // V1 event tables, so seed that row into the full-schema ledger-60 copy.
      const seed = new NodeSqlite.DatabaseSync(copy);
      seed.exec(
        `ATTACH DATABASE '${path.join(fixtures, "local-mbp.threads-projects.sqlite").replaceAll("'", "''")}' AS source`,
      );
      seed.exec(`INSERT OR IGNORE INTO projection_projects SELECT * FROM source.projection_projects
        WHERE project_id IN (SELECT project_id FROM source.projection_threads WHERE thread_id LIKE 'page-agent-%')`);
      seed.exec(
        `INSERT INTO projection_threads SELECT * FROM source.projection_threads WHERE thread_id LIKE 'page-agent-%'`,
      );
      seed.close();
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
        const legacy = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const before = yield* sql<{ thread_id: string; project_id: string; title: string }>`
          SELECT thread_id, project_id, title FROM projection_threads
          WHERE thread_id LIKE 'page-agent-%' AND deleted_at IS NULL`;
        assert.isAbove(before.length, 0);
        yield* legacy.reconcileShells;
        for (const row of before) {
          const imported = (yield* projections.getThreadProjection(ThreadId.make(row.thread_id)))
            .thread;
          assert.equal(imported.id, row.thread_id);
          assert.equal(imported.projectId, row.project_id);
          assert.equal(imported.title, row.title);
          assert.isTrue(isPageAgentThreadId(imported.id));
        }
        const shell = withoutPageAgentThreads({
          threads: before.map((row) => ({ id: row.thread_id })),
        });
        assert.deepEqual(shell.threads, []);
      }).pipe(Effect.provide(Layer.mergeAll(stores, importer)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
} else {
  it.skip("imports a V1 page-agent thread under its own id (T3_LIFECYCLE_FIXTURES is not set)", () => {});
}
