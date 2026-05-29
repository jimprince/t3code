import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalManager, type TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { OrchestrationListenerCallbackError } from "../Errors.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ThreadArchiveCleanupReactor } from "../Services/ThreadArchiveCleanupReactor.ts";
import { ThreadArchiveCleanupReactorLive } from "./ThreadArchiveCleanupReactor.ts";

const unsupported = () => Effect.die(new Error("Unsupported test call")) as never;

function archivedEvent(
  threadId: ThreadId,
): Extract<OrchestrationEvent, { type: "thread.archived" }> {
  return {
    sequence: 1,
    eventId: EventId.make("event-thread-archived"),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.archived",
    occurredAt: "2026-01-01T00:00:00.000Z",
    commandId: CommandId.make("cmd-thread-archive"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread-archive"),
    payload: {
      threadId,
      archivedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    metadata: {},
  };
}

function shell(
  threadId: ThreadId,
  session: OrchestrationThreadShell["session"],
): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-archive-cleanup"),
    title: "Archive cleanup thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: "2026-01-01T00:00:00.000Z",
    session,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

describe("ThreadArchiveCleanupReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ThreadArchiveCleanupReactor, unknown> | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly thread: OrchestrationThreadShell;
    readonly dispatchImplementation?: (
      command: OrchestrationCommand,
    ) => Effect.Effect<{ readonly sequence: number }, OrchestrationListenerCallbackError>;
    readonly closeImplementation?: TerminalManagerShape["close"];
  }) {
    const effects: string[] = [];
    const dispatchedCommands: OrchestrationCommand[] = [];
    const event = archivedEvent(input.thread.id);
    const defaultDispatch = (command: OrchestrationCommand) =>
      Effect.sync(() => {
        dispatchedCommands.push(command);
        return { sequence: dispatchedCommands.length };
      });
    const dispatch = vi.fn((command: OrchestrationCommand) => {
      effects.push(`dispatch:${command.type}`);
      return input.dispatchImplementation
        ? input.dispatchImplementation(command)
        : defaultDispatch(command);
    });
    const close = vi.fn<TerminalManagerShape["close"]>((request) =>
      Effect.sync(() => {
        effects.push(`terminal.close:${request.threadId}`);
      }).pipe(
        Effect.andThen(
          input.closeImplementation ? input.closeImplementation(request) : Effect.void,
        ),
      ),
    );

    runtime = ManagedRuntime.make(
      ThreadArchiveCleanupReactorLive.pipe(
        Layer.provideMerge(
          Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            dispatch,
            streamDomainEvents: Stream.make(event),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery, {
            getCommandReadModel: () => unsupported(),
            getSnapshot: () => unsupported(),
            getShellSnapshot: () => unsupported(),
            getArchivedShellSnapshot: () => unsupported(),
            getSnapshotSequence: () => unsupported(),
            getCounts: () => unsupported(),
            getActiveProjectByWorkspaceRoot: () => unsupported(),
            getProjectShellById: () => unsupported(),
            getFirstActiveThreadIdByProjectId: () => unsupported(),
            getThreadCheckpointContext: () => unsupported(),
            getFullThreadDiffContext: () => unsupported(),
            getThreadShellById: () => unsupported(),
            getThreadShellByIdIncludingArchived: (threadId) =>
              threadId === input.thread.id
                ? Effect.succeed(Option.some(input.thread))
                : Effect.succeed(Option.none()),
            getThreadDetailById: () => unsupported(),
          }),
        ),
        Layer.provideMerge(
          Layer.succeed(TerminalManager, {
            open: () => unsupported(),
            write: () => unsupported(),
            resize: () => unsupported(),
            clear: () => unsupported(),
            restart: () => unsupported(),
            close,
            subscribe: () => Effect.succeed(() => undefined),
          }),
        ),
      ),
    );

    const reactor = await runtime.runPromise(Effect.service(ThreadArchiveCleanupReactor));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime.runPromise(reactor.start().pipe(Scope.provide(scope)));
    await runtime.runPromise(Effect.yieldNow);
    await runtime.runPromise(reactor.drain);

    return { effects, dispatchedCommands, dispatch, close, event };
  }

  it("dispatches session stop and closes terminals after archive", async () => {
    const threadId = ThreadId.make("thread-archive-cleanup");
    const harness = await createHarness({
      thread: shell(threadId, {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });

    expect(harness.effects).toEqual(["dispatch:thread.session.stop", `terminal.close:${threadId}`]);
    expect(harness.dispatchedCommands[0]).toMatchObject({
      type: "thread.session.stop",
      commandId: `server:session-stop-for-archive:${harness.event.eventId}`,
      threadId,
      createdAt: harness.event.occurredAt,
    });
  });

  it("closes terminals without dispatching stop when the thread has no session", async () => {
    const threadId = ThreadId.make("thread-archive-no-session");
    const harness = await createHarness({
      thread: shell(threadId, null),
    });

    expect(harness.effects).toEqual([`terminal.close:${threadId}`]);
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("closes terminals without dispatching stop when the session is already stopped", async () => {
    const threadId = ThreadId.make("thread-archive-stopped-session");
    const harness = await createHarness({
      thread: shell(threadId, {
        threadId,
        status: "stopped",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });

    expect(harness.effects).toEqual([`terminal.close:${threadId}`]);
    expect(harness.dispatch).not.toHaveBeenCalled();
  });

  it("still closes terminals when session stop dispatch fails", async () => {
    const threadId = ThreadId.make("thread-archive-stop-fails");
    const harness = await createHarness({
      thread: shell(threadId, {
        threadId,
        status: "ready",
        providerName: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      dispatchImplementation: (command) => {
        void command;
        return Effect.fail(
          new OrchestrationListenerCallbackError({
            listener: "domain-event",
            detail: "simulated archive stop failure",
          }),
        );
      },
    });

    expect(harness.effects).toEqual(["dispatch:thread.session.stop", `terminal.close:${threadId}`]);
  });

  it("does not fail the reactor when terminal close defects", async () => {
    const threadId = ThreadId.make("thread-archive-terminal-close-defect");
    const harness = await createHarness({
      thread: shell(threadId, null),
      closeImplementation: () => Effect.die(new Error("simulated terminal close defect")),
    });

    expect(harness.effects).toEqual([`terminal.close:${threadId}`]);
  });
});
