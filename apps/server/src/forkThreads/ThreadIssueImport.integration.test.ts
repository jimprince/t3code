import { assertFixtureMigration16 } from "../persistence/fixtureMigration16.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { EventId, ThreadId, ThreadIssueSnapshot } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerFromPath as makeSqlitePersistenceLive } from "../persistence/Sqlite.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import { runForkMigrations } from "../persistence/ForkMigrations.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as LegacyImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";

const fixtures = process.env.T3CODE_FORK_FIXTURES;
const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(ThreadIssueSnapshot));
describe.runIf(fixtures !== undefined)("shipped issue data", () => {
  it.effect.each(["dev-vm", "local-mbp"])(
    "imports %s issue links twice, preserves both ledgers and never alters legacy rows",
    (name) =>
      Effect.gen(function* () {
        const directory = yield* Effect.tryPromise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "fork-issues-")),
        );
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
        );
        const file = NodePath.join(directory, "statev2.sqlite");
        yield* Effect.tryPromise(() =>
          NodeFSP.copyFile(NodePath.join(fixtures!, `${name}.small.sanitized.sqlite`), file),
        );
        yield* assertFixtureMigration16.pipe(
          Effect.provide(NodeSqliteClient.layer({ filename: file })),
        );
        const database = makeSqlitePersistenceLive(file).pipe(
          Layer.provideMerge(NodeServices.layer),
        );
        const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
          Layer.provideMerge(database),
        );
        const sink = EventSink.layer.pipe(Layer.provide(stores));
        const importer = LegacyImporter.layer.pipe(Layer.provide(Layer.merge(stores, sink)));
        const layer = Layer.mergeAll(stores, importer, sink);
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const imports = yield* LegacyImporter.LegacyV1ThreadImporter;
          const projections = yield* ProjectionStore.ProjectionStoreV2;
          const before =
            yield* sql`SELECT * FROM projection_thread_issues ORDER BY thread_id, host, repository, number`;
          const main = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
          const fork = yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`;
          expect(main.at(-1)?.migration_id).toBe(62);
          expect(fork.at(-1)?.migration_id).toBe(16);
          yield* imports.reconcileShells;
          yield* imports.reconcileShells;
          let checked = 0;
          let checkedThread: ThreadId | undefined;
          for (const row of before) {
            const threadId = ThreadId.make(String(row.thread_id));
            const shell = yield* projections.getThreadShell(threadId);
            // Deleted V1 threads intentionally do not have a V2 shell.
            if (shell === null) continue;
            checked += 1;
            checkedThread = threadId;
            const link = shell.issues?.find(
              (issue) =>
                issue.host === row.host &&
                issue.repository === row.repository &&
                issue.number === row.number,
            );
            expect(link).toEqual({
              host: row.host,
              repository: row.repository,
              number: row.number,
              url: row.url,
              linkedAt: row.linked_at,
              snapshot: yield* decodeSnapshot(row.snapshot_json),
            });
          }
          expect(checked).toBeGreaterThan(0);
          const threadId = checkedThread!;
          const current = yield* projections.getThread(threadId);
          const eventSink = yield* EventSink.EventSinkV2;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make(`test:${name}:issue-unlink`),
                type: "thread.metadata-updated",
                threadId,
                providerInstanceId: current.providerInstanceId,
                occurredAt: DateTime.makeUnsafe("2026-10-06T00:00:00.000Z"),
                payload: { ...current, issues: [] },
              },
            ],
          });
          yield* imports.reconcileShells;
          expect((yield* projections.getThreadShell(threadId))!.issues).toEqual([]);
          expect(yield* runMigrations()).toEqual([]);
          expect(yield* runForkMigrations()).toEqual([]);
          expect(yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`).toEqual(
            main,
          );
          expect(
            yield* sql`SELECT * FROM effect_sql_fork_migrations ORDER BY migration_id`,
          ).toEqual(fork);
          expect(
            yield* sql`SELECT * FROM projection_thread_issues ORDER BY thread_id, host, repository, number`,
          ).toEqual(before);
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped),
  );
});
