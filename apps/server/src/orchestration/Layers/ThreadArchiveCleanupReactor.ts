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

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager;

  const requestProviderSessionStop = (event: ThreadArchivedEvent) =>
    logCleanupCauseUnlessInterrupted({
      effect: Effect.gen(function* () {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellByIdIncludingArchived(event.payload.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`server:session-stop-for-archive:${event.eventId}`),
          threadId: event.payload.threadId,
          createdAt: event.occurredAt,
        });
      }),
      message: "thread archive cleanup skipped provider session stop",
      threadId: event.payload.threadId,
    });

  const closeThreadTerminals = (threadId: ThreadArchivedEvent["payload"]["threadId"]) =>
    logCleanupCauseUnlessInterrupted({
      effect: terminalManager.close({ threadId }),
      message: "thread archive cleanup skipped terminal close",
      threadId,
    });

  const processThreadArchived = Effect.fn("processThreadArchived")(function* (
    event: ThreadArchivedEvent,
  ) {
    const { threadId } = event.payload;
    yield* requestProviderSessionStop(event);
    yield* closeThreadTerminals(threadId);
  });

  const processThreadArchivedSafely = (event: ThreadArchivedEvent) =>
    processThreadArchived(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread archive cleanup reactor failed to process event", {
          eventType: event.type,
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processThreadArchivedSafely);

  const start: ThreadArchiveCleanupReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.archived") {
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
