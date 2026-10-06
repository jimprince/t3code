import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { layerMemory as SqlitePersistenceMemory } from "../persistence/Sqlite.ts";
import { makeNestingService } from "./NestingService.ts";
import { validateRemoteParent } from "./RemoteParentService.ts";
it.effect(
  "child-only remote metadata survives restart and clears without native result transfer",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const id = ThreadId.make("child");
      const getShell = (threadId: ThreadId) =>
        Effect.succeed(
          threadId === id
            ? { id, projectId: ProjectId.make("child-project"), archivedAt: null }
            : null,
        );
      const service = yield* makeNestingService(sql, getShell, () => Effect.void);
      const input = {
        threadId: id,
        commandId: CommandId.make("remote"),
        parentThreadId: null,
        remoteParent: { environmentId: "parent-host", threadId: ThreadId.make("parent") },
      };
      yield* validateRemoteParent("child-host", input);
      yield* service.update(input);
      const restart = yield* makeNestingService(sql, getShell, () => Effect.void);
      assert.deepStrictEqual((yield* restart.list())[0]?.remoteParent, input.remoteParent);
      assert.equal(
        (yield* Effect.exit(validateRemoteParent("parent-host", input)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.exit(
          service.update({ ...input, commandId: CommandId.make("both"), parentThreadId: id }),
        ))._tag,
        "Failure",
      );
      yield* service.update({
        threadId: id,
        commandId: CommandId.make("clear"),
        remoteParent: null,
      });
      assert.equal((yield* service.list())[0]?.remoteParent, null);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);
