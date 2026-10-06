import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { initializeMetadata, listMetadata, writeMetadata } from "./MetadataStore.ts";
import { makeNestingService } from "./NestingService.ts";

it.effect(
  "legacy completion policy backfills older sidecars while explicit overrides survive restart",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, parent_thread_id TEXT, scope TEXT, settle_on_complete INTEGER)`;
      yield* sql`INSERT INTO projection_threads VALUES ('child', 'parent', 'legacy', 1), ('off', NULL, NULL, 0), ('default', NULL, NULL, NULL)`;
      yield* initializeMetadata(sql);
      const imported = yield* listMetadata(sql);
      assert.equal(imported.find((row) => row.threadId === "child")?.settleOnComplete, true);
      assert.equal(imported.find((row) => row.threadId === "off")?.settleOnComplete, false);
      assert.equal(imported.find((row) => row.threadId === "default")?.settleOnComplete, null);
      // Simulate a sidecar persisted before lifecycle was integrated.
      yield* writeMetadata(sql, {
        threadId: ThreadId.make("child"),
        parentThreadId: null,
        scope: "V2",
      });
      yield* initializeMetadata(sql);
      const backfilled = (yield* listMetadata(sql)).find((row) => row.threadId === "child")!;
      assert.deepStrictEqual(backfilled, {
        threadId: ThreadId.make("child"),
        parentThreadId: null,
        scope: "V2",
        settleOnComplete: true,
      });
      for (const preference of [false, true, null]) {
        yield* writeMetadata(sql, { ...backfilled, settleOnComplete: preference });
        yield* initializeMetadata(sql);
        assert.equal(
          (yield* listMetadata(sql)).find((row) => row.threadId === "child")?.settleOnComplete,
          preference,
        );
      }
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM projection_threads WHERE thread_id = 'child'`,
        [
          {
            thread_id: "child",
            parent_thread_id: "parent",
            scope: "legacy",
            settle_on_complete: 1,
          },
        ],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect(
  "completion updates preserve parentage and nesting updates preserve policy with durable receipts",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const getShell = (id: ThreadId) =>
        Effect.succeed({ id, projectId: ProjectId.make("project"), archivedAt: null });
      const service = yield* makeNestingService(sql, getShell);
      const threadId = ThreadId.make("child");
      const update = (command: string) => ({ commandId: CommandId.make(command), threadId });
      yield* service.update({
        ...update("combined"),
        parentThreadId: ThreadId.make("parent"),
        scope: "worker",
        settleOnComplete: false,
      });
      yield* service.update({
        ...update("remote"),
        parentThreadId: null,
        remoteParent: { environmentId: "remote", threadId: ThreadId.make("same-id") },
      });
      const enabled = yield* service.update({ ...update("enable"), settleOnComplete: true });
      assert.equal(enabled.parentThreadId, null);
      assert.deepStrictEqual(enabled.remoteParent, {
        environmentId: "remote",
        threadId: "same-id",
      });
      assert.equal(enabled.scope, "worker");
      const reset = yield* service.update({ ...update("default"), settleOnComplete: null });
      assert.equal(reset.settleOnComplete, null);
      yield* service.update({ ...update("enable"), settleOnComplete: true });
      const restart = yield* makeNestingService(sql, getShell);
      assert.deepStrictEqual((yield* restart.list())[0], reset);
      const unnested = yield* restart.update({
        ...update("unnest"),
        parentThreadId: null,
        remoteParent: null,
      });
      assert.equal(unnested.settleOnComplete, null);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
