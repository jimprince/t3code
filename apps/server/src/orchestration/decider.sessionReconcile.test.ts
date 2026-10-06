import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:05:00.000Z";
const THREAD_ID = ThreadId.make("thread-1");
const TURN_ID = TurnId.make("turn-1");

function makeReadModel(input: {
  readonly session: OrchestrationSession | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}) {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: input.latestTurn,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: input.session,
      },
    ],
    updatedAt: NOW,
  } satisfies OrchestrationReadModel;
}

const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: THREAD_ID,
  status: "running",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: TURN_ID,
  lastError: null,
  updatedAt: NOW,
  ...overrides,
});

const turn = (state: OrchestrationLatestTurn["state"]): OrchestrationLatestTurn => ({
  turnId: TURN_ID,
  state,
  requestedAt: NOW,
  startedAt: NOW,
  completedAt: state === "running" ? null : NOW,
  assistantMessageId: null,
});

const reconcile = (readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.session.reconcile",
      commandId: CommandId.make("cmd-reconcile"),
      threadId: THREAD_ID,
      createdAt: LATER,
    },
    readModel,
  });

it.layer(NodeServices.layer)("session reconcile decider", (it) => {
  for (const state of ["interrupted", "completed"] as const) {
    it.effect(`clears a session stuck on a ${state} turn`, () =>
      Effect.gen(function* () {
        const decided = yield* reconcile(
          makeReadModel({ session: session(), latestTurn: turn(state) }),
        );
        const events = Array.isArray(decided) ? decided : [decided];
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          type: "thread.session-set",
          payload: {
            session: { status: "ready", activeTurnId: null, lastError: null, updatedAt: LATER },
          },
        });
      }),
    );
  }

  it.effect("keeps the failure of an errored turn", () =>
    Effect.gen(function* () {
      const decided = yield* reconcile(
        makeReadModel({
          session: session({ lastError: "provider crashed" }),
          latestTurn: turn("error"),
        }),
      );
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events[0]).toMatchObject({
        payload: {
          session: { status: "error", activeTurnId: null, lastError: "provider crashed" },
        },
      });
    }),
  );

  const refused: ReadonlyArray<readonly [string, ReturnType<typeof makeReadModel>]> = [
    [
      "a turn that is still running",
      makeReadModel({ session: session(), latestTurn: turn("running") }),
    ],
    [
      "an idle session",
      makeReadModel({
        session: session({ status: "ready", activeTurnId: null }),
        latestTurn: turn("interrupted"),
      }),
    ],
    [
      "a session on a newer turn",
      makeReadModel({
        session: session({ activeTurnId: TurnId.make("turn-2") }),
        latestTurn: turn("interrupted"),
      }),
    ],
    [
      "a thread without a session",
      makeReadModel({ session: null, latestTurn: turn("interrupted") }),
    ],
  ];
  for (const [label, readModel] of refused) {
    it.effect(`refuses ${label}`, () =>
      Effect.gen(function* () {
        expect(Exit.isFailure(yield* Effect.exit(reconcile(readModel)))).toBe(true);
      }),
    );
  }

  it.effect("an interrupt request ends the named turn in the read model", () =>
    Effect.gen(function* () {
      const event = {
        sequence: 1,
        eventId: EventId.make("event-interrupt"),
        aggregateKind: "thread",
        aggregateId: THREAD_ID,
        occurredAt: LATER,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.turn-interrupt-requested",
        payload: { threadId: THREAD_ID, turnId: TURN_ID, createdAt: LATER },
      } as const satisfies OrchestrationEvent;
      const projected = yield* projectEvent(
        makeReadModel({ session: session(), latestTurn: turn("running") }),
        event,
      );
      expect(projected.threads[0]?.latestTurn).toMatchObject({
        state: "interrupted",
        completedAt: LATER,
      });
      expect(projected.threads[0]?.session?.status).toBe("running");

      const decided = yield* reconcile(projected);
      expect(Array.isArray(decided) ? decided[0]?.type : decided.type).toBe("thread.session-set");
    }),
  );
});
