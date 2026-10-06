import { CommandId } from "@t3tools/contracts";
import { SupervisionDropError, type SupervisionDrop } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { makeNestingService } from "./NestingService.ts";

/** Retryable compound intent: persist parent first; native commands keep their own receipts. */
export const makeSupervisionDrop = (
  sql: SqlClient.SqlClient,
  management: Pick<ThreadManagement.ThreadManagementServiceShape, "getThreadShell" | "dispatch">,
) =>
  Effect.gen(function* () {
    const nesting = yield* makeNestingService(
      sql,
      management.getThreadShell,
      management.dispatch,
    ).pipe(Effect.orDie);
    return {
      "fork.threads.supervision.drop": (input: SupervisionDrop) =>
        Effect.gen(function* () {
          yield* nesting.update({
            commandId: input.commandId,
            threadId: input.threadId,
            parentThreadId: input.parentThreadId,
            remoteParent: null,
          });
          if (input.section === "settled")
            yield* management.dispatch({
              type: "thread.settle",
              commandId: CommandId.make(`${input.commandId}:section`),
              threadId: input.threadId,
            });
          else if (input.section) {
            yield* management.dispatch({
              type: "thread.unsettle",
              commandId: CommandId.make(`${input.commandId}:section`),
              threadId: input.threadId,
              reason: "user",
            });
            yield* management.dispatch({
              type: "thread.unsnooze",
              commandId: CommandId.make(`${input.commandId}:unsnooze`),
              threadId: input.threadId,
              reason: "user",
            });
          }
          for (const assignment of input.assignments ?? []) {
            const metadata = yield* nesting.list();
            const parent =
              metadata.find((m) => m.threadId === assignment.threadId)?.parentThreadId ?? null;
            const shell = yield* management.getThreadShell(assignment.threadId);
            const source = yield* management.getThreadShell(input.threadId);
            if (
              parent !== input.parentThreadId ||
              !shell ||
              !source ||
              (shell.pinnedAt != null) !== (source.pinnedAt != null)
            )
              return yield* new SupervisionDropError({
                message: "Reorder must stay within direct siblings and pin bucket.",
              });
            yield* management.dispatch({
              type: shell.pinnedAt == null ? "thread.active.reorder" : "thread.pin.reorder",
              commandId: CommandId.make(`${input.commandId}:order:${assignment.threadId}`),
              threadId: assignment.threadId,
              orderKey: assignment.orderKey,
            });
          }
          if (input.pinned !== undefined)
            yield* management.dispatch({
              type: input.pinned ? "thread.pin" : "thread.unpin",
              commandId: CommandId.make(`${input.commandId}:pin`),
              threadId: input.threadId,
            });
          if (input.orderKey !== undefined) {
            const shell = yield* management.getThreadShell(input.threadId);
            if (shell !== null)
              yield* management.dispatch({
                type: shell.pinnedAt == null ? "thread.active.reorder" : "thread.pin.reorder",
                commandId: CommandId.make(`${input.commandId}:order`),
                threadId: input.threadId,
                orderKey: input.orderKey,
              });
          }
        }).pipe(Effect.mapError((cause) => new SupervisionDropError({ message: String(cause) }))),
    };
  });

export const makeSupervisionDragHandlers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const management = yield* ThreadManagement.ThreadManagementService;
  return yield* makeSupervisionDrop(sql, management);
});
