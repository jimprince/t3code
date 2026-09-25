import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationSessionStatus,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderSendTurnInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  stoppedBackgroundWorkNotice,
  type StoppedBackgroundTask,
  ThreadBackgroundWorkRecovery,
} from "./orchestration/ThreadBackgroundWorkRecovery.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const defaultProject = ProjectId.make("project-default");
const quietProject = ProjectId.make("project-quiet");
const updatedAt = "2026-09-25T12:00:00.000Z";

const makeThread = (
  id: string,
  options: {
    readonly status?: OrchestrationSessionStatus;
    readonly activeTurnId?: TurnId | null;
    readonly archivedAt?: string | null;
    readonly projectId?: ProjectId;
  } = {},
) => ({
  id: ThreadId.make(id),
  projectId: options.projectId ?? defaultProject,
  archivedAt: options.archivedAt ?? null,
  deletedAt: null,
  interactionMode: "default" as const,
  session: {
    threadId: ThreadId.make(id),
    status: options.status ?? "ready",
    providerName: "codex" as const,
    providerInstanceId,
    runtimeMode: "full-access" as const,
    activeTurnId: options.activeTurnId ?? null,
    lastError: null,
    updatedAt,
  },
});
type TestThread = ReturnType<typeof makeThread>;

const binding = (
  thread: TestThread,
  overrides: Partial<ProviderSessionDirectory.ProviderRuntimeBinding> = {},
): ProviderSessionDirectory.ProviderRuntimeBinding => ({
  threadId: thread.id,
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId,
  status: thread.session.status === "running" ? "running" : "stopped",
  resumeCursor: { threadId: thread.id },
  runtimePayload: { activeTurnId: thread.session.activeTurnId },
  ...overrides,
});

const monitor: StoppedBackgroundTask = {
  taskId: "task-monitor",
  kind: "monitor",
  description: "PR checks",
};
const agent: StoppedBackgroundTask = {
  taskId: "task-agent",
  kind: "agent",
  description: "Refactor worker",
};

/**
 * Runs startup reconciliation with the given stopped work and records every
 * provider turn. `awaitSends` resolves once each listed thread has sent.
 */
const reconcile = (input: {
  readonly threads: ReadonlyArray<TestThread>;
  readonly bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding>;
  readonly stoppedWork: ReadonlyMap<ThreadId, ReadonlyArray<StoppedBackgroundTask>>;
  readonly awaitSends: ReadonlyArray<ThreadId>;
  readonly liveThreadIds?: ReadonlyArray<ThreadId>;
}) =>
  Effect.gen(function* () {
    const sends: ProviderSendTurnInput[] = [];
    const sent = new Map(
      yield* Effect.forEach(input.awaitSends, (threadId) =>
        Deferred.make<void>().pipe(Effect.map((deferred) => [threadId, deferred] as const)),
      ),
    );
    const bindings = new Map(input.bindings.map((entry) => [entry.threadId, entry] as const));
    const providerService: ProviderService.ProviderService["Service"] = {
      startSession: () => Effect.die("unused"),
      compactThread: () => Effect.die("unused"),
      interruptTurn: () => Effect.die("unused"),
      respondToRequest: () => Effect.die("unused"),
      respondToUserInput: () => Effect.die("unused"),
      stopSession: () => Effect.die("unused"),
      listSessions: () =>
        Effect.succeed((input.liveThreadIds ?? []).map((threadId) => ({ threadId }) as never)),
      getCapabilities: () =>
        Effect.succeed({ sessionModelSwitch: "in-session", promptlessTurnContinuation: true }),
      assertConversationRollbackSupported: () => Effect.die("unused"),
      getInstanceInfo: () => Effect.die("unused"),
      rollbackConversation: () => Effect.die("unused"),
      forkConversation: () => Effect.die("unused"),
      uploadFeedback: () => Effect.die("unused"),
      streamEvents: Stream.empty,
      sendTurn: (turn) =>
        Effect.gen(function* () {
          sends.push(turn);
          const deferred = sent.get(turn.threadId);
          if (deferred) yield* Deferred.succeed(deferred, undefined);
          return { threadId: turn.threadId, turnId: TurnId.make(`resumed-${turn.threadId}`) };
        }),
    };

    yield* ServerRuntimeStartup.reconcileProviderSessions.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        getCommandReadModel: () => Effect.succeed({ threads: input.threads } as never),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderService.ProviderService, providerService),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, {
        settleDeadGenerationBinding: () => Effect.die("unused"),
        markTurnStarted: () => Effect.die("unused"),
        markTurnTerminal: () => Effect.die("unused"),
        claimIdleForRecovery: () => Effect.die("unused"),
        recordImportedTranscript: () => Effect.die("unused"),
        getProvider: () => Effect.die("unused"),
        listThreadIds: () => Effect.die("unused"),
        listBindings: () => Effect.succeed([]),
        getBinding: (threadId) => Effect.sync(() => Option.fromNullishOr(bindings.get(threadId))),
        upsert: (next) =>
          Effect.sync(() => {
            bindings.set(next.threadId, { ...bindings.get(next.threadId), ...next });
          }),
      }),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("unused"),
        dispatch: () => Effect.succeed({ sequence: 0 }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      }),
      Effect.provideService(ThreadBackgroundWorkRecovery, {
        sync: () => Effect.void,
        takeAll: Effect.succeed(input.stoppedWork),
      }),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            continueThreadsAfterServerUpdate: true,
            projectSettingsOverrides: {
              [quietProject]: { continueThreadsAfterServerUpdate: false },
            },
          }),
          NodeServices.layer,
        ),
      ),
    );
    yield* Effect.forEach(sent.values(), Deferred.await, { discard: true });
    return sends;
  });

it.effect("tells an idle thread which background work the restart stopped", () =>
  Effect.gen(function* () {
    const noCursor = makeThread("no-cursor");
    const archived = makeThread("archived", { archivedAt: updatedAt });
    const live = makeThread("live");
    const quiet = makeThread("quiet", { projectId: quietProject });
    const nothingStopped = makeThread("nothing-stopped");
    // Last, so any send wrongly forked for an earlier thread runs before it.
    const idle = makeThread("idle");
    const threads = [noCursor, archived, live, quiet, nothingStopped, idle];
    const stopped = [monitor, agent];

    const sends = yield* reconcile({
      threads,
      bindings: threads.map((thread) =>
        binding(thread, thread === noCursor ? { resumeCursor: null } : {}),
      ),
      stoppedWork: new Map(
        [noCursor, archived, live, quiet, idle].map((thread) => [thread.id, stopped] as const),
      ),
      liveThreadIds: [live.id],
      awaitSends: [idle.id],
    });

    assert.deepStrictEqual(sends, [
      {
        threadId: idle.id,
        input: stoppedBackgroundWorkNotice(stopped),
        interactionMode: "default",
      },
    ]);
    assert.include(sends[0]?.input ?? "", "- Monitor: PR checks");
    assert.include(sends[0]?.input ?? "", "- Background agent: Refactor worker");
  }),
);

it.effect("adds the stopped work to a mid-turn continuation instead of a second turn", () =>
  Effect.gen(function* () {
    const midTurn = makeThread("mid-turn", {
      status: "running",
      activeTurnId: TurnId.make("turn-mid"),
    });
    const idle = makeThread("idle");

    const sends = yield* reconcile({
      threads: [midTurn, idle],
      bindings: [binding(midTurn), binding(idle)],
      stoppedWork: new Map([
        [midTurn.id, [monitor]],
        [idle.id, [agent]],
      ]),
      awaitSends: [midTurn.id, idle.id],
    });

    // Promptless continuation would drop the notice, so the provider gets it
    // as the continuation prompt, once.
    assert.deepStrictEqual(
      sends.filter((turn) => turn.threadId === midTurn.id),
      [
        {
          threadId: midTurn.id,
          input: `Continue where you left off.\n\n${stoppedBackgroundWorkNotice([monitor])}`,
          interactionMode: "default",
        },
      ],
    );
  }),
);
