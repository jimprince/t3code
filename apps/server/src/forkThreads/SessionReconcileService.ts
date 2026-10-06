import { CommandId, SessionReconcileError, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";

const isSessionReconcileError = Schema.is(SessionReconcileError);

/** Repairs only an ended latest run; live work must be interrupted through the normal Stop path. */
export const makeSessionReconcileService = (
  threads: Pick<ThreadManagementServiceShape, "getThreadRecords" | "dispatch">,
) => ({
  reconcile: (input: { readonly commandId: CommandId; readonly threadId: ThreadId }) =>
    Effect.gen(function* () {
      const p = yield* threads.getThreadRecords(input.threadId, [
        "runs",
        "attempts",
        "providerThreads",
        "providerTurns",
        "providerSessions",
      ]);
      const latest = p.runs.reduce<(typeof p.runs)[number] | undefined>(
        (latest, run) => (!latest || run.ordinal > latest.ordinal ? run : latest),
        undefined,
      );
      if (
        !latest ||
        ["queued", "preparing", "starting", "running", "waiting"].includes(latest.status)
      )
        return yield* new SessionReconcileError({
          message: "Thread has no session stuck on an ended turn.",
        });
      const providerThread = p.providerThreads.find(
        (thread) => thread.id === latest.providerThreadId,
      );
      const turn = p.providerTurns.find(
        (turn) =>
          turn.runAttemptId === latest.activeAttemptId &&
          turn.providerThreadId === providerThread?.id,
      );
      const session = p.providerSessions.find(
        (session) => session.id === providerThread?.providerSessionId,
      );
      if (
        !providerThread ||
        !turn ||
        !session ||
        !["starting", "running", "waiting"].includes(session.status) ||
        providerThread.lastRunOrdinal !== latest.ordinal
      )
        return yield* new SessionReconcileError({
          message: "Thread has no session stuck on an ended turn.",
        });
      const result = yield* threads.dispatch({
        type: "thread.background-work.settle",
        ...input,
        providerThreadId: providerThread.id,
        providerTurnId: turn.id,
      });
      if (
        !result.storedEvents.some(
          ({ event }) =>
            event.type === "provider-session.updated" &&
            event.payload.id === session.id &&
            ["ready", "error"].includes(event.payload.status),
        )
      )
        return yield* new SessionReconcileError({
          message: "Session changed before it could be reconciled; newer work was preserved.",
        });
    }).pipe(
      Effect.mapError((cause) =>
        isSessionReconcileError(cause)
          ? cause
          : new SessionReconcileError({ message: String(cause) }),
      ),
    ),
});
