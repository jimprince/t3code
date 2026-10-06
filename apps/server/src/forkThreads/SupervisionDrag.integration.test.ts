import { CommandId, ThreadId, type OrchestrationV2ServerCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { v2ThreadShell } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import { makeSupervisionDrop } from "./SupervisionDrag.ts";
import { listMetadata } from "./MetadataStore.ts";
it.effect(
  "persists nesting with retry-stable native commands, rejects cycles and unnests on section drop",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const commands: OrchestrationV2ServerCommand[] = [];
      const a = ThreadId.make("a"),
        b = ThreadId.make("b");
      const handlers = yield* makeSupervisionDrop(sql, {
        getThreadShell: (id) =>
          Effect.succeed([a, b].includes(id) ? { ...v2ThreadShell, id, pinnedAt: null } : null),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            return { sequence: 0, storedEvents: [] };
          }),
      });
      const drop = handlers["fork.threads.supervision.drop"];
      const input = { commandId: CommandId.make("nest"), threadId: a, parentThreadId: b };
      yield* drop(input);
      yield* drop(input);
      expect((yield* listMetadata(sql)).find((t) => t.threadId === a)?.parentThreadId).toBe(b);
      expect(commands.map((c) => c.commandId)).toEqual([
        "nest:shell-refresh",
        "nest:shell-refresh",
      ]);
      const cycle = yield* Effect.result(
        drop({ commandId: CommandId.make("cycle"), threadId: b, parentThreadId: a }),
      );
      expect(cycle._tag).toBe("Failure");
      yield* drop({
        commandId: CommandId.make("section"),
        threadId: a,
        parentThreadId: null,
        section: "active",
        pinned: false,
      });
      expect((yield* listMetadata(sql)).find((t) => t.threadId === a)?.parentThreadId).toBeNull();
      expect(commands.slice(2).map((c) => c.type)).toEqual([
        "thread.metadata.update",
        "thread.unsettle",
        "thread.unsnooze",
        "thread.unpin",
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
