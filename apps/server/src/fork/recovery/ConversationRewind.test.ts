import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { conversationBaselineAllowed, makeConversationRewind } from "./ConversationRewind.ts";
const input = {
  threadId: ThreadId.make("thread"),
  commandId: CommandId.make("rewind"),
  runId: RunId.make("run"),
  messageId: MessageId.make("message"),
  providerThreadId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const time = DateTime.makeUnsafe("2026-10-05T00:00:00Z");
function projection(overrides: object = {}) {
  return {
    thread: {
      id: input.threadId,
      modelSelection: { instanceId: input.providerInstanceId },
      activeProviderThreadId: null,
      archivedAt: null,
      deletedAt: null,
      rollbackRequestId: input.commandId,
    },
    runs: [
      {
        id: input.runId,
        userMessageId: input.messageId,
        ordinal: 1,
        status: "interrupted",
        providerInstanceId: input.providerInstanceId,
        providerThreadId: null,
      },
    ],
    providerThreads: [],
    runtimeRequests: [],
    nodes: [],
    checkpoints: [],
    ...overrides,
  } as unknown as OrchestrationV2ThreadProjection;
}
it.each(["preparing", "queued", "starting", "running", "waiting", "completed", "rolled_back"])(
  "denies %s work at baseline acceptance",
  (status) => {
    const current = projection();
    expect(
      conversationBaselineAllowed(
        { ...current, runs: [{ ...current.runs[0]!, status }] } as OrchestrationV2ThreadProjection,
        input,
      ),
    ).toBe(false);
  },
);
it("denies stale user/run/provider ownership and existing ready filesystem boundaries", () => {
  expect(conversationBaselineAllowed(projection(), input)).toBe(true);
  expect(
    conversationBaselineAllowed(projection(), { ...input, messageId: MessageId.make("stale") }),
  ).toBe(false);
  expect(
    conversationBaselineAllowed(projection(), {
      ...input,
      providerInstanceId: ProviderInstanceId.make("other"),
    }),
  ).toBe(false);
  expect(
    conversationBaselineAllowed(
      projection({ checkpoints: [{ status: "ready", appRunOrdinal: null }] }),
      input,
    ),
  ).toBe(false);
  expect(
    conversationBaselineAllowed(projection({ runtimeRequests: [{ status: "pending" }] }), input),
  ).toBe(false);
});
it.live(
  "writes durable conversation rollback once, without opening a provider or touching files for an unstarted run",
  () =>
    Effect.gen(function* () {
      let current = projection();
      let writes = 0;
      const events: Array<OrchestrationV2DomainEvent> = [];
      const execute = makeConversationRewind({
        projections: { getThreadProjection: () => Effect.succeed(current) } as never,
        sessions: {} as never,
        runtimePolicy: {} as never,
        ids: { allocate: { event: () => Effect.succeed("event" as never) } } as never,
        threadLock: {
          withLock: (_key: unknown, effect: Effect.Effect<unknown>) => effect,
        } as never,
        eventSink: {
          write: (value: { events: Array<OrchestrationV2DomainEvent> }) =>
            Effect.sync(() => {
              writes++;
              events.push(...value.events);
              current = {
                ...current,
                runs: current.runs.map((run) => ({
                  ...run,
                  status: "rolled_back",
                  completedAt: time,
                })),
              };
            }),
        } as never,
      });
      yield* execute(input);
      yield* execute(input);
      expect(writes).toBe(1);
      expect(events.map((event) => event.type)).toEqual(["run.updated"]);
      expect(current.checkpoints).toEqual([]);
      current = {
        ...projection(),
        thread: {
          ...projection().thread,
          modelSelection: { instanceId: ProviderInstanceId.make("changed") } as never,
        },
      };
      expect((yield* Effect.exit(execute(input)))._tag).toBe("Failure");
      expect(writes).toBe(1);
    }),
);

it.live(
  "resumes the owned provider and rewinds to conversation start without a filesystem checkpoint",
  () =>
    Effect.gen(function* () {
      const providerThreadId = ProviderThreadId.make("provider-thread");
      const owned = { ...input, providerThreadId };
      const providerThread = {
        id: providerThreadId,
        providerSessionId: "session",
        providerInstanceId: input.providerInstanceId,
        driver: "codex",
        nativeThreadRef: { nativeId: "native-thread" },
        pendingBackgroundTasks: [],
      };
      const base = projection();
      const current = projection({
        thread: { ...base.thread, activeProviderThreadId: providerThreadId },
        runs: [{ ...base.runs[0]!, providerThreadId }],
        providerThreads: [providerThread],
        providerSessions: [{ id: "session" }],
        providerTurns: [],
      });
      let opened: unknown;
      let target: unknown;
      let written: Array<OrchestrationV2DomainEvent> = [];
      let locked = false;
      const execute = makeConversationRewind({
        projections: { getThreadProjection: () => Effect.succeed(current) } as never,
        runtimePolicy: { resolve: () => Effect.succeed({}) } as never,
        sessions: {
          open: (value: unknown) =>
            Effect.sync(() => {
              expect(locked).toBe(true);
              opened = value;
              return {
                rollbackThread: (value: { target: unknown }) =>
                  Effect.sync(() => {
                    expect(locked).toBe(true);
                    target = value.target;
                    return { providerThread };
                  }),
              };
            }),
        } as never,
        ids: { allocate: { event: () => Effect.succeed("event" as never) } } as never,
        threadLock: {
          withLock: (_key: unknown, effect: Effect.Effect<unknown>) =>
            Effect.acquireUseRelease(
              Effect.sync(() => {
                locked = true;
              }),
              () => effect,
              () =>
                Effect.sync(() => {
                  locked = false;
                }),
            ),
        } as never,
        eventSink: {
          write: (value: { events: Array<OrchestrationV2DomainEvent> }) =>
            Effect.sync(() => {
              expect(locked).toBe(true);
              written = value.events;
            }),
        } as never,
      });
      yield* execute(owned);
      expect(opened).toMatchObject({
        providerSessionId: "session",
        initialNativeThreadId: "native-thread",
        resumeFromSession: { id: "session" },
      });
      expect(target).toEqual({ type: "thread_start", appRunOrdinal: 0 });
      expect(written.map((event) => event.type)).toEqual([
        "provider-thread.updated",
        "run.updated",
      ]);
      expect(current.checkpoints).toEqual([]);
    }),
);
