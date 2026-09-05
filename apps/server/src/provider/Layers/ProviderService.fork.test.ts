/* oxlint-disable t3code/no-manual-effect-runtime-in-tests -- verbatim copies of the upstream test file's harness helpers; the upstream file carries the same legacy allowance. */
import type { EventId } from "@t3tools/contracts";
import type {
  ProviderApprovalDecision,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderTurnStartResult,
  ProviderUploadFeedbackInput,
  ProviderUploadFeedbackResult,
} from "@t3tools/contracts";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionStartInput,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { it, assert, describe, vi } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeServerBootGenerationLayer } from "./ServerBootGeneration.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import { makeAdapterRegistryMock } from "../testUtils/providerAdapterRegistryMock.ts";

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};
// Fork-added test cases extracted from the upstream test file so that upstream
// edits to that file never conflict with the fork. Helpers are copied, not
// imported: upstream keeps them file-local.

const defaultServerSettingsLayer = ServerSettings.ServerSettingsService.layerTest();

const serverConfigTestLayer = ServerConfig.layerTest(process.cwd(), process.cwd()).pipe(
  Layer.provide(NodeServices.layer),
);

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const asTurnId = (value: string): TurnId => TurnId.make(value);

const codexInstanceId = ProviderInstanceId.make("codex");

const claudeAgentInstanceId = ProviderInstanceId.make("claudeAgent");

const CODEX_DRIVER = ProviderDriverKind.make("codex");

const CLAUDE_AGENT_DRIVER = ProviderDriverKind.make("claudeAgent");

const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

function makeFakeCodexAdapter(
  provider: ProviderDriverKind = CODEX_DRIVER,
  supportsConversationRollback?: boolean,
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());

  const startSession = vi.fn((input: ProviderSessionStartInput) =>
    Effect.sync(() => {
      const now = "2026-01-01T00:00:00.000Z";
      const session: ProviderSession = {
        provider,
        ...(input.providerInstanceId !== undefined
          ? { providerInstanceId: input.providerInstanceId }
          : {}),
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        resumeCursor: input.resumeCursor ?? {
          opaque: `resume-${String(input.threadId)}`,
        },
        cwd: input.cwd ?? process.cwd(),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(session.threadId, session);
      return session;
    }),
  );

  const sendTurn = vi.fn(
    (
      input: ProviderSendTurnInput,
    ): Effect.Effect<ProviderTurnStartResult, ProviderAdapterError> => {
      if (!sessions.has(input.threadId)) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider,
            threadId: input.threadId,
          }),
        );
      }

      return Effect.succeed({
        threadId: input.threadId,
        turnId: TurnId.make(`turn-${String(input.threadId)}`),
      });
    },
  );

  const interruptTurn = vi.fn(
    (_threadId: ThreadId, _turnId?: TurnId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.void,
  );

  const respondToRequest = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _decision: ProviderApprovalDecision,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const respondToUserInput = vi.fn(
    (
      _threadId: ThreadId,
      _requestId: string,
      _answers: Record<string, unknown>,
    ): Effect.Effect<void, ProviderAdapterError> => Effect.void,
  );

  const stopSession = vi.fn((threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.delete(threadId);
    }),
  );

  const listSessions = vi.fn((): Effect.Effect<ReadonlyArray<ProviderSession>> =>
    Effect.sync(() => Array.from(sessions.values())),
  );

  const hasSession = vi.fn((threadId: ThreadId): Effect.Effect<boolean> =>
    Effect.succeed(sessions.has(threadId)),
  );

  const readThread = vi.fn(
    (
      threadId: ThreadId,
    ): Effect.Effect<
      {
        threadId: ThreadId;
        turns: ReadonlyArray<{ id: TurnId; items: readonly [] }>;
      },
      ProviderAdapterError
    > =>
      Effect.succeed({
        threadId,
        turns: [{ id: asTurnId("turn-1"), items: [] }],
      }),
  );

  const rollbackThread = vi.fn(
    (
      threadId: ThreadId,
      _numTurns: number,
    ): Effect.Effect<{ threadId: ThreadId; turns: readonly [] }, ProviderAdapterError> =>
      Effect.succeed({ threadId, turns: [] }),
  );

  const uploadFeedback = vi.fn(
    (
      input: ProviderUploadFeedbackInput,
    ): Effect.Effect<ProviderUploadFeedbackResult, ProviderAdapterError> =>
      Effect.succeed({ feedbackId: `feedback-${input.threadId}` }),
  );

  const stopAll = vi.fn((): Effect.Effect<void, ProviderAdapterError> =>
    Effect.sync(() => {
      sessions.clear();
    }),
  );

  const adapter: ProviderAdapterShape<ProviderAdapterError> = {
    provider,
    capabilities: {
      sessionModelSwitch: "in-session",
      ...(supportsConversationRollback !== undefined ? { supportsConversationRollback } : {}),
      ...(provider === CODEX_DRIVER ? { promptlessTurnContinuation: true } : {}),
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    ...(provider === CODEX_DRIVER ? { uploadFeedback } : {}),
    stopAll,
    get streamEvents() {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  const updateSession = (
    threadId: ThreadId,
    update: (session: ProviderSession) => ProviderSession,
  ): void => {
    const existing = sessions.get(threadId);
    if (!existing) {
      return;
    }
    sessions.set(threadId, update(existing));
  };

  return {
    adapter,
    emit,
    updateSession,
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    uploadFeedback,
    stopAll,
  };
}

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

function makeProviderServiceLayer(
  input: {
    readonly directory?: ProviderSessionDirectory.ProviderSessionDirectory["Service"];
    readonly supportsConversationRollback?: boolean;
    readonly registry?: ProviderAdapterRegistry.ProviderAdapterRegistry["Service"];
  } = {},
) {
  const codex = makeFakeCodexAdapter(CODEX_DRIVER, input.supportsConversationRollback);
  const claude = makeFakeCodexAdapter(CLAUDE_AGENT_DRIVER);
  const cursor = makeFakeCodexAdapter(CURSOR_DRIVER);
  const registry =
    input.registry ??
    makeAdapterRegistryMock({
      [ProviderDriverKind.make("codex")]: codex.adapter,
      [ProviderDriverKind.make("claudeAgent")]: claude.adapter,
      [ProviderDriverKind.make("cursor")]: cursor.adapter,
    });

  const providerAdapterLayer = Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistry,
    registry,
  );
  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const directoryLayer =
    input.directory === undefined
      ? ProviderSessionDirectoryLive.pipe(
          Layer.provide(runtimeRepositoryLayer),
          Layer.provide(makeServerBootGenerationLayer("test-boot-generation")),
        )
      : Layer.succeed(ProviderSessionDirectory.ProviderSessionDirectory, input.directory);

  const layer = it.layer(
    Layer.mergeAll(
      makeProviderServiceLive().pipe(
        Layer.provide(providerAdapterLayer),
        Layer.provide(directoryLayer),
        Layer.provide(defaultServerSettingsLayer),
        Layer.provide(serverConfigTestLayer),
        Layer.provideMerge(AnalyticsService.layerTest),
        Layer.provide(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
      ),
      directoryLayer,

      runtimeRepositoryLayer,
      NodeServices.layer,
    ),
  );

  return {
    codex,
    claude,
    cursor,
    layer,
  };
}

const routing = makeProviderServiceLayer();

const getBinding = vi.fn((threadId: ThreadId) =>
  Effect.succeed(
    Option.some({
      threadId,
      provider: CODEX_DRIVER,
      providerInstanceId: codexInstanceId,
    }),
  ),
);

routing.layer("ProviderServiceLive routing (fork)", (it) => {
  it.effect("reserves an active-turn marker before the provider send can complete", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-reservation");
      const turnId = asTurnId("turn-send-reservation");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      const previewValue = (yield* directory.listBindings()).find(
        (binding) => binding.threadId === threadId,
      );
      const previewBinding = previewValue === undefined ? Option.none() : Option.some(previewValue);
      assert.equal(Option.isSome(previewBinding), true);
      if (Option.isNone(previewBinding)) return;

      const sendGate = yield* Deferred.make<ProviderTurnStartResult>();
      routing.codex.sendTurn.mockImplementationOnce(() => Deferred.await(sendGate));
      const sendFiber = yield* provider
        .sendTurn({
          threadId,
          input: "hold the provider response",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      while (routing.codex.sendTurn.mock.calls.length === 0) {
        yield* Effect.yieldNow;
      }

      const reservedBinding = yield* directory.getBinding(threadId);
      assert.equal(Option.isSome(reservedBinding), true);
      if (Option.isSome(reservedBinding)) {
        assert.match(
          String(reservedBinding.value.activeTurnId),
          /^pending:/,
          "REGRESSION: recovery could observe the session as idle while sendTurn was in flight",
        );
      }
      assert.equal(
        yield* directory.claimIdleForRecovery({
          threadId,
          expectedLastSeenAt: previewBinding.value.lastSeenAt,
        }),
        false,
        "REGRESSION: recovery claimed a provider while sendTurn was in flight",
      );

      yield* Deferred.succeed(sendGate, { threadId, turnId });
      const turn = yield* Fiber.join(sendFiber);
      assert.equal(turn.turnId, turnId);
      const activeBinding = yield* directory.getBinding(threadId);
      assert.equal(
        Option.getOrUndefined(activeBinding)?.activeTurnId,
        turnId,
        "REGRESSION: the pending marker was not replaced by the provider turn id",
      );
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );
  it.effect("does not resurrect a turn that completed before sendTurn returned", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-fast-completion");
      const turnId = asTurnId("turn-send-fast-completion");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockImplementationOnce(() =>
        Effect.gen(function* () {
          yield* directory.markTurnStarted({ threadId, turnId });
          yield* directory.markTurnTerminal({ threadId, expectedTurnId: turnId });
          return { threadId, turnId };
        }).pipe(Effect.orDie),
      );

      yield* provider.sendTurn({
        threadId,
        input: "complete before send returns",
        attachments: [],
      });

      const binding = yield* directory.getBinding(threadId);
      assert.equal(
        Option.getOrUndefined(binding)?.activeTurnId,
        null,
        "REGRESSION: sendTurn overwrote an already-terminal lifecycle update",
      );
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );
  it.effect("reconciles an old persisted turn marker when the live provider is idle", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-stale-marker");
      const staleTurnId = asTurnId("turn-send-stale-marker");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.sendTurn.mockClear();
      assert.equal(yield* directory.markTurnStarted({ threadId, turnId: staleTurnId }), true);
      yield* advanceTestClock(5_001);

      const turn = yield* provider.sendTurn({
        threadId,
        input: "recover this stale provider turn",
        attachments: [],
      });

      assert.equal(turn.turnId, asTurnId(`turn-${String(threadId)}`));
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.getOrUndefined(binding)?.activeTurnId, turn.turnId);
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );
  it.effect("allows only one concurrent sender to claim a reconciled stale marker", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-stale-marker-race");
      const staleTurnId = asTurnId("turn-send-stale-marker-race");
      const providerTurnId = asTurnId("turn-send-stale-marker-race-winner");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      assert.equal(yield* directory.markTurnStarted({ threadId, turnId: staleTurnId }), true);
      yield* advanceTestClock(5_001);

      const sendGate = yield* Deferred.make<ProviderTurnStartResult>();
      routing.codex.sendTurn.mockClear();
      routing.codex.sendTurn.mockImplementationOnce(() => Deferred.await(sendGate));
      const firstFiber = yield* provider
        .sendTurn({
          threadId,
          input: "first concurrent sender",
          attachments: [],
        })
        .pipe(Effect.exit, Effect.forkChild);
      const secondFiber = yield* provider
        .sendTurn({
          threadId,
          input: "second concurrent sender",
          attachments: [],
        })
        .pipe(Effect.exit, Effect.forkChild);
      while (routing.codex.sendTurn.mock.calls.length === 0) {
        yield* Effect.yieldNow;
      }
      yield* Deferred.succeed(sendGate, { threadId, turnId: providerTurnId });

      const [firstExit, secondExit] = yield* Effect.all(
        [Fiber.join(firstFiber), Fiber.join(secondFiber)],
        { concurrency: "unbounded" },
      );
      const exits = [firstExit, secondExit];
      assert.equal(exits.filter(Exit.isSuccess).length, 1);
      assert.equal(exits.filter(Exit.isFailure).length, 1);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 1);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.getOrUndefined(binding)?.activeTurnId, providerTurnId);
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );
  for (const markerAgeMs of [0, 5_001]) {
    it.effect(`delivers a steer without replacing a live marker aged ${markerAgeMs}ms`, () =>
      Effect.gen(function* () {
        const provider = yield* ProviderService.ProviderService;
        const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
        const threadId = asThreadId(`thread-send-steer-${markerAgeMs}`);
        const activeTurnId = asTurnId(`turn-send-steer-${markerAgeMs}`);
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
        routing.codex.updateSession(threadId, (session) => ({
          ...session,
          status: "running",
          activeTurnId,
        }));
        assert.equal(yield* directory.markTurnStarted({ threadId, turnId: activeTurnId }), true);
        if (markerAgeMs > 0) yield* advanceTestClock(markerAgeMs);

        const deliveredInputs: string[] = [];
        routing.codex.sendTurn.mockImplementationOnce((input) =>
          Effect.gen(function* () {
            const binding = yield* directory.getBinding(threadId);
            assert.equal(Option.getOrUndefined(binding)?.activeTurnId, activeTurnId);
            deliveredInputs.push(input.input ?? "");
            return { threadId, turnId: activeTurnId };
          }).pipe(Effect.orDie),
        );
        const turn = yield* provider.sendTurn({
          threadId,
          input: "incorporate this follow-up into the running turn",
          attachments: [],
        });

        assert.deepEqual(deliveredInputs, ["incorporate this follow-up into the running turn"]);
        assert.equal(turn.turnId, activeTurnId);
        const activeTurnBinding = yield* directory.getBinding(threadId);
        assert.equal(Option.getOrUndefined(activeTurnBinding)?.activeTurnId, activeTurnId);
        const recoveryBinding = (yield* directory.listBindings()).find(
          (candidate) => candidate.threadId === threadId,
        );
        assert.isDefined(recoveryBinding);
        assert.equal(
          yield* directory.claimIdleForRecovery({
            threadId,
            expectedLastSeenAt: recoveryBinding!.lastSeenAt,
          }),
          false,
        );
        yield* provider.stopSession({ threadId });
        routing.codex.sendTurn.mockClear();
      }),
    );
  }
  it.effect("preserves the live marker when a steer fails in the adapter", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-steer-failure");
      const activeTurnId = asTurnId("turn-send-steer-failure");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (session) => ({
        ...session,
        status: "running",
        activeTurnId,
      }));
      assert.equal(yield* directory.markTurnStarted({ threadId, turnId: activeTurnId }), true);
      const adapterError = new ProviderAdapterRequestError({
        provider: CODEX_DRIVER,
        method: "sendTurn",
        detail: "steer rejected by provider",
      });
      routing.codex.sendTurn.mockImplementationOnce(() => Effect.fail(adapterError));
      const failure = yield* Effect.flip(
        provider.sendTurn({
          threadId,
          input: "follow-up rejected by adapter",
          attachments: [],
        }),
      );
      assert.equal(failure, adapterError);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.getOrUndefined(binding)?.activeTurnId, activeTurnId);
      yield* provider.stopSession({ threadId });
      routing.codex.sendTurn.mockClear();
    }),
  );
  it.effect("rejects a persisted marker that differs from the live provider turn", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const threadId = asThreadId("thread-send-live-marker");
      const activeTurnId = asTurnId("turn-send-live-marker");
      yield* provider.startSession(threadId, {
        provider: CODEX_DRIVER,
        providerInstanceId: codexInstanceId,
        threadId,
        runtimeMode: "full-access",
      });
      routing.codex.updateSession(threadId, (session) => ({
        ...session,
        status: "running",
        activeTurnId: asTurnId("different-live-turn"),
      }));
      assert.equal(yield* directory.markTurnStarted({ threadId, turnId: activeTurnId }), true);
      routing.codex.sendTurn.mockClear();
      yield* advanceTestClock(5_001);

      const failure = yield* Effect.flip(
        provider.sendTurn({
          threadId,
          input: "do not start a concurrent provider turn",
          attachments: [],
        }),
      );

      assert.instanceOf(failure, ProviderValidationError);
      assert.include(failure.issue, "another turn or session transition is in progress");
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      const binding = yield* directory.getBinding(threadId);
      assert.equal(Option.getOrUndefined(binding)?.activeTurnId, activeTurnId);
      yield* provider.stopSession({ threadId });
    }),
  );
  it.effect("does not reconcile pending or recently-created turn markers", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const recentThreadId = asThreadId("thread-send-recent-marker");
      const recentTurnId = asTurnId("turn-send-recent-marker");
      const pendingThreadId = asThreadId("thread-send-pending-marker");
      const pendingTurnId = asTurnId("pending:other-send");
      for (const threadId of [recentThreadId, pendingThreadId]) {
        yield* provider.startSession(threadId, {
          provider: CODEX_DRIVER,
          providerInstanceId: codexInstanceId,
          threadId,
          runtimeMode: "full-access",
        });
      }
      assert.equal(
        yield* directory.markTurnStarted({
          threadId: recentThreadId,
          turnId: recentTurnId,
        }),
        true,
      );
      assert.equal(
        yield* directory.markTurnStarted({
          threadId: pendingThreadId,
          turnId: pendingTurnId,
        }),
        true,
      );
      routing.codex.sendTurn.mockClear();

      const recentFailure = yield* Effect.flip(
        provider.sendTurn({
          threadId: recentThreadId,
          input: "preserve a recent marker",
          attachments: [],
        }),
      );
      yield* advanceTestClock(5_001);
      const pendingFailure = yield* Effect.flip(
        provider.sendTurn({
          threadId: pendingThreadId,
          input: "preserve a pending marker",
          attachments: [],
        }),
      );

      assert.instanceOf(recentFailure, ProviderValidationError);
      assert.instanceOf(pendingFailure, ProviderValidationError);
      assert.equal(routing.codex.sendTurn.mock.calls.length, 0);
      const recentBinding = yield* directory.getBinding(recentThreadId);
      const pendingBinding = yield* directory.getBinding(pendingThreadId);
      assert.equal(Option.getOrUndefined(recentBinding)?.activeTurnId, recentTurnId);
      assert.equal(Option.getOrUndefined(pendingBinding)?.activeTurnId, pendingTurnId);
      yield* provider.stopSession({ threadId: recentThreadId });
      yield* provider.stopSession({ threadId: pendingThreadId });
    }),
  );
  it.effect("creates a fallback fork binding without resuming an unsupported provider", () =>
    Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-fallback-source");
      const targetThreadId = asThreadId("thread-fork-fallback-target");
      yield* provider.startSession(sourceThreadId, {
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        threadId: sourceThreadId,
        cwd: "/tmp/source-project",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId: sourceThreadId });
      routing.codex.startSession.mockClear();

      const result = yield* provider.forkConversation({
        sourceThreadId,
        targetThreadId,
        cwd: "/tmp/fork-project",
        retainedTurnCount: 1,
        retainedTurnId: TurnId.make("turn-1"),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(codexInstanceId, "gpt-5.6-terra"),
      });
      const targetBinding = yield* directory
        .getBinding(targetThreadId)
        .pipe(Effect.map(Option.getOrUndefined));

      assert.equal(result.native, false);
      assert.equal(routing.codex.startSession.mock.calls.length, 0);
      assert.equal(targetBinding?.resumeCursor, null);
      assert.deepEqual(targetBinding?.runtimePayload, {
        cwd: "/tmp/fork-project",
        modelSelection: createModelSelection(codexInstanceId, "gpt-5.6-terra"),
      });
    }),
  );
  it.effect("falls back when a provider-native fork fails", () => {
    const forkThread = vi.fn<NonNullable<ProviderAdapterShape<ProviderAdapterError>["forkThread"]>>(
      () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: String(CLAUDE_AGENT_DRIVER),
            method: "thread/fork",
            detail: "simulated native fork failure",
          }),
        ),
    );
    Object.assign(routing.claude.adapter, { forkThread });

    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-error-source");
      const targetThreadId = asThreadId("thread-fork-error-target");
      yield* provider.startSession(sourceThreadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId: sourceThreadId,
        cwd: "/tmp/source-project",
        runtimeMode: "full-access",
      });

      const result = yield* provider.forkConversation({
        sourceThreadId,
        targetThreadId,
        cwd: "/tmp/fork-project",
        retainedTurnCount: 1,
        retainedTurnId: TurnId.make("turn-1"),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(claudeAgentInstanceId, "claude-fable-5"),
      });
      const targetBinding = yield* directory
        .getBinding(targetThreadId)
        .pipe(Effect.map(Option.getOrUndefined));

      assert.equal(result.native, false);
      assert.equal(forkThread.mock.calls.length, 1);
      assert.equal(targetBinding?.resumeCursor, null);
      yield* provider.stopSession({ threadId: sourceThreadId });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete (routing.claude.adapter as { forkThread?: unknown }).forkThread;
          routing.claude.startSession.mockClear();
          routing.claude.stopSession.mockClear();
        }),
      ),
    );
  });
  it.effect("stops a source session recovered only for a native fork", () => {
    const forkThread = vi.fn<NonNullable<ProviderAdapterShape<ProviderAdapterError>["forkThread"]>>(
      () =>
        Effect.succeed({
          resumeCursor: { resume: "forked-provider-session" },
          turnCount: 1,
        }),
    );
    Object.assign(routing.claude.adapter, { forkThread });

    return Effect.gen(function* () {
      const provider = yield* ProviderService.ProviderService;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const sourceThreadId = asThreadId("thread-fork-recovered-source");
      const targetThreadId = asThreadId("thread-fork-recovered-target");
      yield* provider.startSession(sourceThreadId, {
        provider: CLAUDE_AGENT_DRIVER,
        providerInstanceId: claudeAgentInstanceId,
        threadId: sourceThreadId,
        cwd: "/tmp/source-project",
        runtimeMode: "full-access",
      });
      yield* provider.stopSession({ threadId: sourceThreadId });
      const stoppedSourceBinding = yield* directory
        .getBinding(sourceThreadId)
        .pipe(Effect.map(Option.getOrUndefined));
      assert.notEqual(stoppedSourceBinding, undefined);
      if (stoppedSourceBinding === undefined) return;
      yield* directory.upsert({
        ...stoppedSourceBinding,
        runtimePayload: {
          ...(stoppedSourceBinding.runtimePayload as Record<string, unknown>),
          threadTransferContextHandoff: {
            version: 1,
            consumedExportedAt: "2026-07-19T00:00:00.000Z",
          },
        },
      });
      routing.claude.startSession.mockClear();
      routing.claude.stopSession.mockClear();

      const result = yield* provider.forkConversation({
        sourceThreadId,
        targetThreadId,
        cwd: "/tmp/fork-project",
        retainedTurnCount: 1,
        retainedTurnId: TurnId.make("turn-1"),
        runtimeMode: "full-access",
        modelSelection: createModelSelection(claudeAgentInstanceId, "claude-fable-5"),
      });
      const sourceBinding = yield* directory
        .getBinding(sourceThreadId)
        .pipe(Effect.map(Option.getOrUndefined));
      const targetBinding = yield* directory
        .getBinding(targetThreadId)
        .pipe(Effect.map(Option.getOrUndefined));

      assert.equal(result.native, true);
      assert.equal(routing.claude.startSession.mock.calls.length, 1);
      assert.deepEqual(routing.claude.stopSession.mock.calls, [[sourceThreadId]]);
      assert.equal(yield* routing.claude.hasSession(sourceThreadId), false);
      assert.equal(sourceBinding?.status, "stopped");
      assert.deepEqual(
        (targetBinding?.runtimePayload as Record<string, unknown> | undefined)
          ?.threadTransferContextHandoff,
        {
          version: 1,
          consumedExportedAt: "2026-07-19T00:00:00.000Z",
        },
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          delete (routing.claude.adapter as { forkThread?: unknown }).forkThread;
          routing.claude.startSession.mockClear();
          routing.claude.stopSession.mockClear();
        }),
      ),
    );
  });
});
