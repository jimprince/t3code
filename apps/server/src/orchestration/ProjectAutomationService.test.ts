import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import {
  CommandId,
  OrchestrationEvent,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ProjectAutomation,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import * as Automations from "./ProjectAutomationService.ts";

const decodeEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const NOW = "2026-10-03T06:00:00.000Z";
const projectId = ProjectId.make("project");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const definition = {
  id: "daily",
  name: "Digest",
  prompt: "Summarize changes",
  enabled: true,
  schedule: { kind: "daily", time: "07:00", timeZone: "UTC" } as const,
  target: { kind: "new-thread" } as const,
};
const project = {
  id: projectId,
  title: "Project",
  workspaceRoot: "/tmp/automation-test",
  defaultModelSelection: model,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
};
const thread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell => ({
  id: ThreadId.make("root"),
  projectId,
  title: "Root",
  modelSelection: model,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  session: null,
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  createdAt: NOW,
  updatedAt: NOW,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

it.layer(NodeServices.layer)("automation persistence transitions", (it) => {
  it.effect("replays create, edit, pause, resume, run-now and delete without losing history", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse(NOW));
      let state: OrchestrationReadModel = { ...createEmptyReadModel(NOW), projects: [project] };
      const dispatch = Effect.fn(function* (command: OrchestrationCommand) {
        const event = yield* decideOrchestrationCommand({ command, readModel: state });
        if (!("type" in event)) throw new Error("Expected one metadata event");
        const persisted = yield* decodeEvent({
          ...event,
          sequence: state.snapshotSequence + 1,
        });
        state = yield* projectEvent(state, persisted);
      });
      yield* dispatch({
        type: "project.automation.create",
        projectId,
        commandId: CommandId.make("create"),
        automation: definition,
      });
      expect(state.projects[0]?.automations?.[0]?.nextRunAt).toBe("2026-10-03T07:00:00.000Z");
      yield* dispatch({
        type: "project.automation.run",
        projectId,
        commandId: CommandId.make("run"),
        automationId: definition.id,
      });
      yield* dispatch({
        type: "project.automation.update",
        projectId,
        commandId: CommandId.make("edit"),
        automation: { ...definition, name: "Updated" },
      });
      expect(state.projects[0]?.automations?.[0]?.runs[0]?.prompt).toBe(definition.prompt);
      expect(state.projects[0]?.automations?.[0]?.runs[0]?.name).toBe("Digest");
      yield* dispatch({
        type: "project.automation.pause",
        projectId,
        commandId: CommandId.make("pause"),
        automationId: definition.id,
      });
      expect(state.projects[0]?.automations?.[0]?.enabled).toBe(false);
      yield* dispatch({
        type: "project.automation.resume",
        projectId,
        commandId: CommandId.make("resume"),
        automationId: definition.id,
      });
      expect(state.projects[0]?.automations?.[0]?.enabled).toBe(true);
      yield* dispatch({
        type: "project.automation.delete",
        projectId,
        commandId: CommandId.make("delete"),
        automationId: definition.id,
      });
      expect(state.projects[0]?.automations).toEqual([]);
    }),
  );
});

function harness(
  automation: ProjectAutomation,
  target?: OrchestrationThreadShell,
  existingMessage = false,
) {
  return Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    let current = automation;
    let shell = target;
    let messagePresent = existingMessage;
    const commands: OrchestrationCommand[] = [];
    const receipts = yield* Queue.unbounded<OrchestrationCommand>();
    const reads = yield* Queue.unbounded<void>();
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const activation = yield* Deferred.make<void>();
    const deps = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        subscribeDomainEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        dispatch: (command) =>
          Effect.gen(function* () {
            commands.push(command);
            if (command.type === "project.automation.fire") {
              const readModel = {
                ...createEmptyReadModel(NOW),
                projects: [{ ...project, automations: [current] }],
              };
              const event = yield* decideOrchestrationCommand({ command, readModel }).pipe(
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.orDie,
              );
              if (!("type" in event)) throw new Error("Expected metadata event");
              const persisted = yield* decodeEvent({
                ...event,
                sequence: 1,
              }).pipe(Effect.orDie);
              const updated = yield* projectEvent(readModel, persisted).pipe(Effect.orDie);
              current = updated.projects[0]!.automations![0]!;
              yield* PubSub.publish(events, persisted);
            } else if (command.type === "project.automation.run.update") {
              current = {
                ...current,
                runs: current.runs.map((run) =>
                  run.id === command.runId
                    ? { ...run, status: command.status, result: command.result }
                    : run,
                ),
              };
            } else if (command.type === "thread.turn.start") {
              shell = thread({ id: command.threadId, latestUserMessageAt: command.createdAt });
              messagePresent = true;
            }
            yield* Queue.offer(receipts, command);
            return { sequence: commands.length };
          }),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Queue.offer(reads, undefined).pipe(
            Effect.andThen(
              Effect.succeed({
                snapshotSequence: 0,
                projects: [{ ...project, automations: [current] }],
                threads: shell ? [shell] : [],
                updatedAt: NOW,
              }),
            ),
          ),
        getThreadShellByIdIncludingArchived: () =>
          Effect.succeed(shell ? Option.some(shell) : Option.none()),
        getTurnStartMessage: ({ messageId }) =>
          Effect.succeed(
            messagePresent
              ? Option.some({
                  message: {
                    id: messageId,
                    role: "user" as const,
                    text: definition.prompt,
                    turnId: shell?.latestTurn?.turnId ?? null,
                    streaming: false,
                    createdAt: NOW,
                    updatedAt: NOW,
                  },
                  hasOtherUserMessages: false,
                  hasTransferredHistory: false,
                })
              : Option.none(),
          ),
      }),
      Layer.mock(ServerSettingsService)({
        getSettings: Effect.succeed({ ...DEFAULT_SERVER_SETTINGS, defaultModelSelection: model }),
      }),
      Layer.succeed(ServerActivation, Deferred.await(activation)),
    );
    return {
      layer: Automations.layer.pipe(Layer.provide(deps)),
      commands,
      receipts,
      reads,
      activate: Deferred.succeed(activation, undefined),
      read: () => current,
      setShell: (value: OrchestrationThreadShell) => {
        shell = value;
      },
      event: (event: OrchestrationEvent) => PubSub.publish(events, event),
    };
  });
}
import * as Stream from "effect/Stream";
const automation = (overrides: Partial<ProjectAutomation> = {}): ProjectAutomation => ({
  ...definition,
  nextRunAt: "2026-10-03T07:00:00.000Z",
  runs: [],
  ...overrides,
});
const queued = {
  name: "Digest",
  target: { kind: "existing-thread" as const, threadId: ThreadId.make("root") },
  id: "run-1",
  scheduledAt: NOW,
  startedAt: null,
  finishedAt: null,
  threadId: ThreadId.make("root"),
  messageId: MessageId.make("message-1"),
  prompt: definition.prompt,
  status: "queued" as const,
  result: null,
};

it.layer(NodeServices.layer)("automation timer", (it) => {
  it.effect(
    "sleeps until due, creates a fresh thread with project defaults, and advances the persisted deadline",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse(NOW));
          const h = yield* harness(automation());
          yield* Effect.gen(function* () {
            const service = yield* Automations.ProjectAutomationService;
            yield* service.start();
            yield* h.activate;
            yield* Queue.take(h.reads);
            yield* service.drain;
            expect(h.commands).toEqual([]);
            yield* TestClock.adjust("1 hour");
            const fire = yield* Queue.take(h.receipts);
            expect(fire.type).toBe("project.automation.fire");
            const start = yield* Queue.take(h.receipts);
            expect(start.type).toBe("thread.turn.start");
            if (start.type === "thread.turn.start") {
              expect(start.bootstrap?.createThread?.modelSelection).toEqual(model);
              expect(start.message.text).toBe(definition.prompt);
              expect(start.bootstrap?.createThread?.title).toContain("Digest ·");
            }
            yield* service.drain;
            expect(h.read().nextRunAt).toBe("2026-10-04T07:00:00.000Z");
          }).pipe(Effect.provide(h.layer));
        }),
      ),
  );
  it.effect("runs only the latest missed hourly occurrence after a long restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness(
          automation({
            schedule: { kind: "hourly", timeZone: "UTC" },
            nextRunAt: "2026-09-30T07:00:00.000Z",
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* Automations.ProjectAutomationService;
          yield* service.start();
          yield* h.activate;
          yield* Queue.take(h.receipts);
          yield* service.drain;
          expect(h.read().runs).toHaveLength(1);
          expect(h.read().runs[0]?.scheduledAt).toBe(NOW);
          expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
  it.effect("skips a weekly missed run older than 24 hours", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness(
          automation({
            schedule: { kind: "weekly", day: 1, time: "07:00", timeZone: "UTC" },
            nextRunAt: "2026-09-28T07:00:00.000Z",
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* Automations.ProjectAutomationService;
          yield* service.start();
          yield* h.activate;
          yield* Queue.take(h.receipts);
          yield* service.drain;
          expect(h.read().runs[0]?.status).toBe("skipped");
          expect(h.commands.filter((c) => c.type === "thread.turn.start")).toHaveLength(0);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
  it.effect("queues a busy existing target and sends at the next boundary", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness(
          automation({
            target: { kind: "existing-thread", threadId: queued.threadId },
            runs: [queued],
          }),
          thread({
            latestTurn: {
              turnId: TurnId.make("busy"),
              state: "running",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: null,
              assistantMessageId: null,
            },
          }),
        );
        yield* Effect.gen(function* () {
          const service = yield* Automations.ProjectAutomationService;
          yield* service.start();
          yield* h.activate;
          yield* Queue.take(h.reads);
          yield* service.drain;
          expect(h.commands).toEqual([]);
          h.setShell(thread());
          yield* h.event({
            sequence: 1,
            eventId: EventId.make("idle"),
            aggregateKind: "thread",
            aggregateId: queued.threadId,
            occurredAt: NOW,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.session-set",
            payload: {
              threadId: queued.threadId,
              session: {
                threadId: queued.threadId,
                status: "ready",
                providerName: "codex",
                runtimeMode: "full-access",
                activeTurnId: null,
                lastError: null,
                updatedAt: NOW,
              },
            },
          });
          expect((yield* Queue.take(h.receipts)).type).toBe("thread.turn.start");
          yield* service.drain;
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
  it.effect("fails an archived target without dispatching a turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness(
          automation({
            target: { kind: "existing-thread", threadId: queued.threadId },
            runs: [queued],
          }),
          thread({ archivedAt: NOW }),
        );
        yield* Effect.gen(function* () {
          const service = yield* Automations.ProjectAutomationService;
          yield* service.start();
          yield* h.activate;
          yield* Queue.take(h.receipts);
          yield* service.drain;
          expect(h.read().runs[0]?.status).toBe("failed");
          expect(h.read().runs[0]?.result).toContain("archived");
          expect(h.commands.filter((c) => c.type === "thread.turn.start")).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
  it.effect("recovers dispatch before status persistence without sending twice", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse(NOW));
        const h = yield* harness(
          automation({ runs: [queued] }),
          thread({
            latestTurn: {
              turnId: TurnId.make("finished"),
              state: "completed",
              requestedAt: NOW,
              startedAt: NOW,
              completedAt: NOW,
              assistantMessageId: null,
            },
          }),
          true,
        );
        yield* Effect.gen(function* () {
          const service = yield* Automations.ProjectAutomationService;
          yield* service.start();
          yield* h.activate;
          yield* Queue.take(h.receipts);
          yield* service.drain;
          expect(h.read().runs[0]?.status).toBe("completed");
          expect(h.commands.filter((c) => c.type === "thread.turn.start")).toEqual([]);
        }).pipe(Effect.provide(h.layer));
      }),
    ),
  );
});
import { EventId } from "@t3tools/contracts";
