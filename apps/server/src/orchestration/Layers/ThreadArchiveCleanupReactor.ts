import { CommandId, type OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { TerminalManager } from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadArchiveCleanupReactor,
  type ThreadArchiveCleanupReactorShape,
} from "../Services/ThreadArchiveCleanupReactor.ts";
import { logCleanupCauseUnlessInterrupted } from "./ThreadDeletionReactor.ts";

type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type ThreadSettledEvent = Extract<OrchestrationEvent, { type: "thread.settled" }>;
// "Parking" a thread — archive or settle — means "done with this thread", so a
// live provider session must not keep running background work afterwards.
// Archive additionally closes terminals; settle leaves them open.
type ThreadParkedEvent = ThreadArchivedEvent | ThreadSettledEvent;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager;

  const requestProviderSessionStop = (event: ThreadParkedEvent) =>
    logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellByIdIncludingArchived(event.payload.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }

        const parkingKind = event.type === "thread.archived" ? "archive" : "settle";
        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`server:session-stop-for-${parkingKind}:${event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
          // A settled thread can be re-engaged before this stop is decided;
          // the decider then drops the stop instead of killing the new
          // session. Archive stops stay unconditional: turn starts on
          // archived threads are rejected, so there is no new session to
          // protect.
          ...(event.type === "thread.settled" ? { onlyIfSettled: true } : {}),
        });
      }),
      message: "thread parking cleanup skipped provider session stop",
      threadId: event.payload.threadId,
    });

  const closeThreadTerminals = (threadId: ThreadArchivedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId }),
      message: "thread archive cleanup skipped terminal close",
      threadId,
    });

  const processThreadParked = Effect.fn("processThreadParked")(function* (
    event: ThreadParkedEvent,
  ) {
    const { threadId } = event.payload;
    yield* requestProviderSessionStop(event);
    if (event.type === "thread.archived") {
      yield* closeThreadTerminals(threadId);
    }
  });

  const processThreadParkedSafely = (event: ThreadParkedEvent) =>
    processThreadParked(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread parking cleanup reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadParkedSafely);

  const start: ThreadArchiveCleanupReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.archived" && event.type !== "thread.settled") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadArchiveCleanupReactorShape;
});

export const ThreadArchiveCleanupReactorLive = Layer.effect(ThreadArchiveCleanupReactor, make);
