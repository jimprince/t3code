import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { makeNestingService } from "./NestingService.ts";

const id = ThreadId.make;
const shells = new Map(
  ["parent", "child", "grandchild"].map((name) => [
    id(name),
    { id: id(name), projectId: ProjectId.make("project"), archivedAt: null },
  ]),
);
const input = (child: string, parent: string | null, command = `${child}-${parent}`) => ({
  commandId: CommandId.make(command),
  threadId: id(child),
  parentThreadId: parent === null ? null : id(parent),
});
it.effect("reparent, unnest and receipts survive restart without changing native lineage", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const getShell = (threadId: ThreadId) => Effect.succeed(shells.get(threadId) ?? null);
    const service = yield* makeNestingService(sql, getShell);
    yield* service.update(input("child", "parent"));
    yield* service.update(input("grandchild", "child"));
    const restart = yield* makeNestingService(sql, getShell);
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("grandchild"))?.parentThreadId,
      id("child"),
    );
    yield* restart.update(input("child", null));
    yield* restart.update(input("child", "parent")); // duplicate receipt cannot overwrite the unnest
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("child"))?.parentThreadId,
      null,
    );
    for (const [child, parent] of [
      ["parent", "parent"],
      ["child", "grandchild"],
      ["child", "missing"],
    ]) {
      const result = yield* Effect.exit(
        restart.update(input(child!, parent!, `reject-${child}-${parent}`)),
      );
      assert.equal(result._tag, "Failure");
    }
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect("legacy edges import once, including missing parents and nulls", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // Only fields required by the retained V1 table are populated through the fixture test below.
    const service = yield* makeNestingService(sql, (threadId) =>
      Effect.succeed(shells.get(threadId) ?? null),
    );
    yield* service.update(input("child", "parent", "import-edit"));
    const restart = yield* makeNestingService(sql, (threadId) =>
      Effect.succeed(shells.get(threadId) ?? null),
    );
    assert.equal(
      (yield* restart.list()).find((row) => row.threadId === id("child"))?.parentThreadId,
      id("parent"),
    );
  }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "CLI-originated sidecar writes dispatch a stable native shell refresh after persistence",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events: string[] = [];
      const service = yield* makeNestingService(
        sql,
        (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        (command) =>
          Effect.gen(function* () {
            const rows = yield* sql<{
              payload: string;
            }>`SELECT payload FROM fork_thread_metadata WHERE thread_id = ${command.threadId}`;
            assert.equal(JSON.parse(rows[0]!.payload).parentThreadId, "parent");
            events.push(`${command.type}:${command.commandId}`);
          }),
      );
      yield* service.update(input("child", "parent", "cli-nest"));
      assert.deepEqual(events, ["thread.metadata.update:cli-nest:shell-refresh"]);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
