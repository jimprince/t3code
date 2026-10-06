import {
  ForkThreadMetadataError,
  type CommandId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
/** Reset delegates validation, persistence and command receipts to native reorder commands. */
export const resetThreadOrder = (
  management: Pick<ThreadManagement.ThreadManagementServiceShape, "getThreadShell" | "dispatch">,
  input: { commandId: CommandId; threadId: ThreadId },
) =>
  Effect.gen(function* () {
    const thread = yield* management.getThreadShell(input.threadId);
    if (
      !thread ||
      thread.archivedAt !== null ||
      (thread.pinnedAt === null && thread.settledOverride === "settled")
    )
      return yield* new ForkThreadMetadataError({
        message: "Thread is missing, archived or outside an orderable section.",
      });
    yield* management.dispatch({
      type: thread.pinnedAt === null ? "thread.active.reorder" : "thread.pin.reorder",
      ...input,
      orderKey: null,
    });
  });
/** A reset of the pinned section changes no activity timestamp. */
export const pinnedReorderUpdatedAt = (
  thread: Pick<OrchestrationV2ThreadShell, "pinOrderKey" | "updatedAt">,
  orderKey: string | null,
  now: DateTime.Utc,
) => (orderKey === null || thread.pinOrderKey === orderKey ? thread.updatedAt : now);
