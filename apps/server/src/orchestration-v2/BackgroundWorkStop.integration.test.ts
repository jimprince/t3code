import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Option from "effect/Option";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

// Codex turns leave commands running, then the thread moves to another
// provider thread (a provider switch). Stop must end all of the Codex work,
// including when it selects an older resumed run on the other provider thread.
const stopEarlierBackgroundWork = ({
  failedStart = false,
  stopWithQueue,
  olderStart = false,
  stalledRun,
}: {
  readonly failedStart?: boolean;
  readonly stopWithQueue?: "thread.stop" | "run.interrupt";
  readonly olderStart?: boolean;
  readonly stalledRun?:
    | "missing-session"
    | "missing-session-terminal"
    | "returned-interrupt"
    | "returned-interrupt-terminal"
    | "superseded-attempt";
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("background-work-stop");
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
      const interrupts: ProviderAdapter.ProviderAdapterV2InterruptInput[] = [];
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        instanceId,
        driver,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            return {
              instanceId,
              driver,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.fromQueue(events),
              ensureThread: ({ threadId }) =>
                Effect.succeed({
                  id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
                  driver,
                  providerInstanceId: instanceId,
                  providerSessionId: input.providerSessionId,
                  appThreadId: threadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                }),
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: (turn) =>
                Effect.gen(function* () {
                  started.push(turn);
                  yield* Queue.offer(events, {
                    type: "provider_turn.updated",
                    driver,
                    providerTurn: {
                      id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                      providerThreadId: turn.providerThread.id,
                      nodeId: turn.rootNodeId,
                      runAttemptId: turn.attemptId,
                      nativeTurnRef: {
                        driver,
                        nativeId: `native:${turn.attemptId}`,
                        strength: "strong",
                      },
                      ordinal: turn.providerTurnOrdinal,
                      status: "running",
                      startedAt: now,
                      completedAt: null,
                    },
                  });
                }),
              steerTurn: () => Effect.die("unused"),
              interruptTurn: (interrupt) =>
                Effect.sync(() => {
                  interrupts.push(interrupt);
                }),
              respondToRuntimeRequest: () => Effect.die("unused"),
              readThreadSnapshot: () => Effect.die("unused"),
              rollbackThread: () => Effect.die("unused"),
              forkThread: () => Effect.die("unused"),
            };
          }),
      };
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const sink = yield* EventSink.EventSinkV2;
        const threadId = ThreadId.make("thread:background-work-stop");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:background-work-stop"),
          title: "Background work stop",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });
        const running = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("start-dev-server"),
          threadId,
          messageId: MessageId.make("message:start-dev-server"),
          text: "Start the dev server",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(running);
        const first = started[0]!;
        const codexTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
        const devServerId = TurnItemId.make("turn-item:dev-server");
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("dev-server"),
              type: "turn-item.updated",
              threadId,
              runId: first.runId,
              occurredAt: now,
              payload: {
                id: devServerId,
                threadId,
                runId: first.runId,
                nodeId: first.rootNodeId,
                providerThreadId: codexTurn.providerThreadId,
                providerTurnId: codexTurn.id,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 100,
                status: "running",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                type: "command_execution",
                input: "vp run dev --share",
              },
            },
          ],
        });
        if (stalledRun !== undefined) {
          const before = yield* orchestrator.getThreadProjection(threadId);
          const run = before.runs[0]!;
          const node = before.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const attempt = before.attempts[0]!;
          if (stalledRun === "missing-session" || stalledRun === "missing-session-terminal") {
            const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
            const failed = yield* watch(
              (event) => event.type === "run.updated" && event.payload.status === "failed",
            );
            yield* sessions.release({
              providerSessionId: first.providerThread.providerSessionId!,
              reason: "runtime_error",
            });
            yield* Fiber.join(failed);
            // Disk exhaustion can lose these terminal writes. Restore that stale state.
            yield* sink.write({
              events: [
                {
                  id: EventId.make("stale-run"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: run,
                },
                {
                  id: EventId.make("stale-node"),
                  type: "node.updated",
                  threadId,
                  occurredAt: now,
                  payload: node,
                },
                {
                  id: EventId.make("stale-attempt"),
                  type: "run-attempt.updated",
                  threadId,
                  occurredAt: now,
                  payload: attempt,
                },
              ],
            });
          }
          const messageId = MessageId.make("partial-output");
          const item = before.turnItems.find((candidate) => candidate.id === devServerId)!;
          assert.ok(item.type === "command_execution");
          const terminalProviderTurn = stalledRun.endsWith("-terminal");
          if (terminalProviderTurn) {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("terminal-provider-turn"),
                  type: "provider-turn.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...codexTurn, status: "completed", completedAt: now },
                },
                ...(stalledRun === "missing-session-terminal"
                  ? [
                      {
                        id: EventId.make("completed-dev-server"),
                        type: "turn-item.updated" as const,
                        threadId,
                        occurredAt: now,
                        payload: { ...item, status: "completed" as const, completedAt: now },
                      },
                    ]
                  : []),
              ],
            });
          }
          yield* sink.write({
            events: [
              {
                id: EventId.make("partial-message"),
                type: "message.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: messageId,
                  threadId,
                  runId: run.id,
                  nodeId: node.id,
                  role: "assistant",
                  text: "Partial output",
                  attachments: [],
                  streaming: true,
                  createdBy: "agent",
                  creationSource: "provider",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("partial-item"),
                type: "turn-item.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...item,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                  id: TurnItemId.make("partial-output"),
                  type: "assistant_message",
                  messageId,
                  text: "Partial output",
                  streaming: true,
                },
              },
            ],
          });
          if (stalledRun === "superseded-attempt") {
            yield* sink.write({
              events: [
                {
                  id: EventId.make("new-attempt"),
                  type: "run.updated",
                  threadId,
                  occurredAt: now,
                  payload: { ...run, activeAttemptId: RunAttemptId.make("new-attempt") },
                },
              ],
            });
          }
          yield* orchestrator.dispatch(
            stalledRun === "superseded-attempt"
              ? {
                  type: "thread.background-work.settle",
                  commandId: CommandId.make("late-settle"),
                  threadId,
                  providerThreadId: codexTurn.providerThreadId,
                  providerTurnId: codexTurn.id,
                }
              : {
                  type: "thread.stop",
                  commandId: CommandId.make("stop-stalled-run"),
                  threadId,
                },
          );
          yield* worker.drain();
          const nativeCompletion = stalledRun === "returned-interrupt-terminal";
          if (stalledRun === "returned-interrupt" || nativeCompletion) {
            // This adapter returns an ACK without a terminal receipt. The run
            // must remain live through the grace period, even when a native
            // provider-turn update has already reached the projection.
            const acknowledged = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(acknowledged.runs[0]?.status, "running");
            assert.equal(acknowledged.attempts[0]?.status, "running");
            assert.equal(
              acknowledged.turnItems.find((item) => item.type === "run_interrupt_request")?.title,
              "Stop acknowledged",
            );
            yield* TestClock.adjust("9999 millis");
            yield* worker.drain();
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
              "running",
            );
            if (nativeCompletion) {
              // Complete the native receipt's checkpoint path during grace;
              // Stop must retain that outcome instead of replacing it.
              const completed = yield* watch(
                (event) =>
                  event.type === "run.updated" &&
                  event.payload.id === run.id &&
                  event.payload.status === "waiting",
              );
              const partial = yield* orchestrator.getThreadProjection(threadId);
              const message = partial.messages.find((candidate) => candidate.id === messageId);
              const assistant = partial.turnItems.find(
                (candidate) => candidate.id === TurnItemId.make("partial-output"),
              );
              assert.ok(message);
              assert.ok(assistant?.type === "assistant_message");
              const finishedAt = yield* DateTime.now;
              // Codex item/completed closes its message and turn item before
              // turn/completed. Deliver that native path through ingestion.
              yield* Queue.offer(events, {
                type: "message.updated",
                driver,
                message: { ...message, streaming: false, updatedAt: finishedAt },
              });
              yield* Queue.offer(events, {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  ...assistant,
                  status: "completed",
                  streaming: false,
                  completedAt: finishedAt,
                  updatedAt: finishedAt,
                },
              });
              yield* Queue.offer(events, {
                type: "turn.terminal",
                driver,
                providerThreadId: codexTurn.providerThreadId,
                providerTurnId: codexTurn.id,
                runOrdinal: first.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              });
              yield* Fiber.join(completed);
              yield* worker.drain();
            }
            yield* TestClock.adjust("1 millis");
            yield* worker.drain();
          }
          const after = yield* orchestrator.getThreadProjection(threadId);
          const interrupted = stalledRun !== "superseded-attempt" && !nativeCompletion;
          const runStatus = nativeCompletion
            ? "completed"
            : interrupted
              ? "interrupted"
              : "running";
          assert.equal(after.runs[0]?.status, runStatus);
          assert.equal(after.attempts[0]?.status, runStatus);
          assert.equal(
            after.providerTurns[0]?.status,
            terminalProviderTurn ? "completed" : interrupted ? "interrupted" : "running",
          );
          assert.equal(
            after.nodes.find((candidate) => candidate.id === node.id)?.status,
            runStatus,
          );
          const output = after.messages.find((message) => message.id === messageId)!;
          assert.equal(output.streaming, !interrupted && !nativeCompletion);
          assert.equal(output.text, "Partial output");
          assert.equal(
            after.turnItems.find((candidate) => candidate.id === devServerId)?.status,
            stalledRun === "missing-session-terminal"
              ? "completed"
              : interrupted || nativeCompletion
                ? "interrupted"
                : "running",
          );
          assert.equal(
            after.turnItems.find((candidate) => candidate.type === "assistant_message")?.status,
            runStatus,
          );
          assert.equal(
            after.turnItems.filter((candidate) => candidate.type === "run_interrupt_result").length,
            interrupted ? 1 : 0,
          );
          assert.isEmpty(after.runs.filter((candidate) => candidate.status === "waiting"));
          return;
        }
        const settled = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === first.runId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...codexTurn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: codexTurn.providerThreadId,
          providerTurnId: codexTurn.id,
          runOrdinal: first.runOrdinal,
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
        yield* Fiber.join(settled);
        yield* worker.drain();

        const codexProviderThread = (yield* orchestrator.getThreadProjection(threadId))
          .providerThreads[0]!;
        // A settled run with its root node, attempt, provider turn and,
        // optionally, a command or native subagent it left running.
        const settledRun = (input: {
          readonly ordinal: number;
          readonly providerThreadId: ProviderThreadId;
          readonly runningItem?: {
            readonly id: TurnItemId;
            readonly kind: "command" | "subagent";
          };
        }) => {
          const runId = RunId.make(`run:${input.ordinal}`);
          const attemptId = RunAttemptId.make(`attempt:${input.ordinal}`);
          const nodeId = NodeId.make(`node:${input.ordinal}`);
          const providerTurnId = ProviderTurnId.make(`provider-turn:${input.ordinal}`);
          const events: Array<OrchestrationV2DomainEvent> = [
            {
              id: EventId.make(`run:${input.ordinal}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: input.ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: input.providerThreadId,
                userMessageId: MessageId.make(`message:${input.ordinal}`),
                rootNodeId: nodeId,
                activeAttemptId: attemptId,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`node:${input.ordinal}`),
              type: "node.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: nodeId,
                threadId,
                runId,
                parentNodeId: null,
                rootNodeId: nodeId,
                kind: "root_turn",
                status: "completed",
                countsForRun: true,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                nativeItemRef: null,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`attempt:${input.ordinal}`),
              type: "run-attempt.created",
              threadId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId,
                attemptOrdinal: 1,
                rootNodeId: nodeId,
                providerInstanceId: instanceId,
                providerThreadId: input.providerThreadId,
                providerTurnId,
                reason: "initial",
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make(`provider-turn:${input.ordinal}`),
              type: "provider-turn.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId: input.providerThreadId,
                nodeId,
                runAttemptId: attemptId,
                nativeTurnRef: null,
                ordinal: input.ordinal,
                status: "completed",
                startedAt: now,
                completedAt: now,
              },
            },
          ];
          const item = input.runningItem;
          if (item !== undefined) {
            const base = {
              id: item.id,
              threadId,
              runId,
              nodeId,
              providerThreadId: input.providerThreadId,
              providerTurnId,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: input.ordinal * 100,
              status: "running",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } as const;
            events.push({
              id: EventId.make(`item:${input.ordinal}`),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: now,
              payload:
                item.kind === "command"
                  ? { ...base, type: "command_execution", input: "vp run test --watch" }
                  : {
                      ...base,
                      // A native subagent item names its own provider thread
                      // but its parent's provider turn.
                      providerThreadId: ProviderThreadId.make("provider-thread:codex-subagent"),
                      type: "subagent",
                      subagentId: NodeId.make(`subagent:${input.ordinal}`),
                      origin: "provider_native",
                      driver,
                      providerInstanceId: instanceId,
                      childThreadId: null,
                      prompt: "Review the change",
                      result: null,
                    },
            });
          }
          return { runId, providerTurnId, events };
        };

        // Later Codex runs leave a second command and a native subagent. Then
        // the thread moves on to another provider thread, which also has a
        // live session.
        const watcherId = TurnItemId.make("turn-item:watcher");
        const otherProviderThreadId = ProviderThreadId.make("provider-thread:other");
        const watcherRun = settledRun({
          ordinal: 2,
          providerThreadId: olderStart ? otherProviderThreadId : codexProviderThread.id,
          ...(olderStart ? {} : { runningItem: { id: watcherId, kind: "command" as const } }),
        });
        const reviewerId = TurnItemId.make("turn-item:reviewer");
        const reviewerRun = settledRun({
          ordinal: 3,
          providerThreadId: codexProviderThread.id,
          runningItem: { id: reviewerId, kind: "subagent" },
        });
        const latestRun = settledRun({ ordinal: 4, providerThreadId: otherProviderThreadId });
        yield* sink.write({
          events: [
            ...watcherRun.events,
            ...reviewerRun.events,
            {
              id: EventId.make("provider-thread:codex-latest"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: { ...codexProviderThread, lastRunOrdinal: 3 },
            },
            {
              id: EventId.make("provider-thread:other"),
              type: "provider-thread.updated",
              threadId,
              occurredAt: now,
              payload: {
                ...codexProviderThread,
                id: otherProviderThreadId,
                firstRunOrdinal: 4,
                lastRunOrdinal: 4,
              },
            },
            ...latestRun.events,
          ],
        });

        const failedRun = settledRun({ ordinal: 5, providerThreadId: otherProviderThreadId });
        if (failedStart) {
          yield* sink.write({
            events: failedRun.events.flatMap((event): Array<OrchestrationV2DomainEvent> => {
              switch (event.type) {
                case "provider-turn.updated":
                  return [];
                case "run.created":
                  return [{ ...event, payload: { ...event.payload, status: "failed" } }];
                case "node.updated":
                  return [
                    {
                      ...event,
                      payload: { ...event.payload, status: "failed", providerTurnId: null },
                    },
                  ];
                case "run-attempt.created":
                  return [
                    {
                      ...event,
                      payload: { ...event.payload, status: "failed", providerTurnId: null },
                    },
                  ];
                default:
                  return [event];
              }
            }),
          });
        }

        if (stopWithQueue !== undefined) {
          const owner = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === latestRun.runId,
          )!;
          // A message queues while checkpointing finishes, then the user holds the queue.
          yield* sink.write({
            events: [
              {
                id: EventId.make("latest-run-waiting"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: { ...owner, status: "waiting", completedAt: null },
              },
            ],
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("queue-follow-up"),
            threadId,
            messageId: MessageId.make("message:queue-follow-up"),
            text: "Follow up after the background work",
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "user",
            creationSource: "web",
          });
          const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          assert.equal(queued.status, "queued");
          yield* sink.write({
            events: [
              {
                id: EventId.make("queue-held"),
                type: "run.updated",
                threadId,
                runId: queued.id,
                occurredAt: now,
                payload: { ...queued, queueHeld: true },
              },
              {
                id: EventId.make("latest-run-settled"),
                type: "run.updated",
                threadId,
                runId: owner.id,
                occurredAt: now,
                payload: owner,
              },
            ],
          });
        }

        if (olderStart) {
          const older = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
            (run) => run.id === watcherRun.runId,
          )!;
          // A resumed queue can start a lower-ordinal run after later runs have ended.
          yield* sink.write({
            events: [
              {
                id: EventId.make("older-run-starting"),
                type: "run.updated",
                threadId,
                runId: older.id,
                occurredAt: now,
                payload: { ...older, status: "starting", startedAt: null, completedAt: null },
              },
            ],
          });
        }

        const stopReceipts = yield* Ref.make<OrchestrationV2DomainEvent[]>([]);
        yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter((event) => event.threadId === threadId),
          Stream.runForEach((event) => Ref.update(stopReceipts, (events) => [...events, event])),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* orchestrator.dispatch(
          stopWithQueue === "thread.stop"
            ? {
                type: "thread.stop",
                commandId: CommandId.make("stop-background-work"),
                threadId,
              }
            : {
                type: "run.interrupt",
                commandId: CommandId.make("stop-background-work"),
                threadId,
                runId: olderStart
                  ? watcherRun.runId
                  : failedStart
                    ? failedRun.runId
                    : latestRun.runId,
                ...(stopWithQueue === undefined ? {} : { holdQueue: true }),
              },
        );
        yield* worker.drain();

        if (!olderStart && !failedStart && stopWithQueue === undefined) {
          const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const ackCommand = {
            type: "thread.background-work.settle" as const,
            commandId: CommandId.make(
              `effect:stop-background-work:provider-turn.interrupt:${reviewerRun.providerTurnId}:background-work-settled`,
            ),
            threadId,
            providerThreadId: codexProviderThread.id,
            providerTurnId: reviewerRun.providerTurnId,
            interruptAcknowledged: true,
          };
          assert.equal(
            Option.getOrThrow(yield* receipts.getByCommandId(ackCommand.commandId)).status,
            "accepted",
          );
          assert.lengthOf(
            yield* sink
              .readByCommandId({ commandId: ackCommand.commandId })
              .pipe(Stream.runCollect),
            0,
          );
          const fallback = Option.getOrThrow(
            yield* outbox.get(`effect:interrupt-settle:${ackCommand.commandId}`),
          );
          assert.equal(fallback.status, "pending");
          assert.equal(Date.parse(fallback.availableAt), DateTime.toEpochMillis(now) + 10_000);
          assert.deepEqual(fallback.request, {
            type: "provider-turn.interrupt-settle",
            providerThreadId: codexProviderThread.id,
            providerTurnId: reviewerRun.providerTurnId,
          });
          yield* orchestrator.dispatch(ackCommand);
          const replayed = yield* outbox.listByCommandId(fallback.commandId);
          assert.lengthOf(replayed, 1);
          assert.equal(Date.parse(replayed[0]!.availableAt), Date.parse(fallback.availableAt));
        }

        // This mock only acknowledges Stop. Without a native terminal event,
        // all background commands stay live until the bounded fallback.
        const backgroundIds = [devServerId, ...(olderStart ? [] : [watcherId]), reviewerId];
        const backgroundStatuses = () =>
          orchestrator
            .getThreadProjection(threadId)
            .pipe(
              Effect.map((projection) =>
                backgroundIds.map(
                  (id) => projection.turnItems.find((item) => item.id === id)?.status,
                ),
              ),
            );
        assert.deepEqual(
          yield* backgroundStatuses(),
          backgroundIds.map(() => "running"),
        );
        yield* TestClock.adjust("9999 millis");
        yield* worker.drain();
        assert.deepEqual(
          yield* backgroundStatuses(),
          backgroundIds.map(() => "running"),
        );
        yield* TestClock.adjust("1 millis");
        yield* worker.drain();

        // The Codex interrupt targets its latest pending work, the subagent's parent turn,
        // so its settlement covers the Codex background work.
        assert.sameDeepMembers(
          interrupts.map((interrupt) => [interrupt.providerThread.id, interrupt.providerTurnId]),
          [
            ...(olderStart ? [] : [[otherProviderThreadId, latestRun.providerTurnId]]),
            [codexProviderThread.id, reviewerRun.providerTurnId],
          ],
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        if (olderStart) {
          assert.equal(
            after.runs.find((run) => run.id === watcherRun.runId)?.status,
            "interrupted",
          );
        }
        if (stopWithQueue !== undefined) {
          assert.equal(after.runs.at(-1)?.status, "queued");
          assert.equal(after.runs.at(-1)?.queueHeld, true);
          assert.lengthOf(started, 1);
        }
        assert.deepEqual(
          [devServerId, ...(olderStart ? [] : [watcherId]), reviewerId].map(
            (id) => after.turnItems.find((item) => item.id === id)?.status,
          ),
          olderStart
            ? ["interrupted", "interrupted"]
            : ["interrupted", "interrupted", "interrupted"],
          JSON.stringify({
            clock: DateTime.formatIso(yield* DateTime.now),
            runs: after.runs.map(({ id, ordinal, status, activeAttemptId, providerThreadId }) => ({
              id,
              ordinal,
              status,
              activeAttemptId,
              providerThreadId,
            })),
            providerThreads: after.providerThreads.map(
              ({ id, lastRunOrdinal, providerSessionId }) => ({
                id,
                lastRunOrdinal,
                providerSessionId,
              }),
            ),
            items: after.turnItems
              .filter((item) => backgroundIds.includes(item.id))
              .map(({ id, runId, providerThreadId, providerTurnId, status }) => ({
                id,
                runId,
                providerThreadId,
                providerTurnId,
                status,
              })),
            receipts: (yield* Ref.get(stopReceipts)).map((event) => ({
              id: event.id,
              type: event.type,
              at: DateTime.formatIso(event.occurredAt),
              payloadId: "id" in event.payload ? event.payload.id : undefined,
              status: "status" in event.payload ? event.payload.status : undefined,
            })),
          }),
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "background-work-stop" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
      );
    }),
  );

it.effect("Stop reaches background work an earlier provider thread still runs", () =>
  stopEarlierBackgroundWork({}),
);

it.effect(
  "Stop reaches earlier background work after the newest run fails before provider start",
  () => stopEarlierBackgroundWork({ failedStart: true }),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s stops background work when a later message is queued",
  (stopType) => stopEarlierBackgroundWork({ stopWithQueue: stopType }),
);

it.effect.each(["thread.stop", "run.interrupt"] as const)(
  "%s reaches later background work when an older run is starting",
  (stopType) => stopEarlierBackgroundWork({ stopWithQueue: stopType, olderStart: true }),
);

it.effect.each([
  "missing-session",
  "missing-session-terminal",
  "returned-interrupt",
  "returned-interrupt-terminal",
  "superseded-attempt",
] as const)("Stop recovers a stalled run after %s without changing a newer attempt", (stalledRun) =>
  stopEarlierBackgroundWork({ stalledRun }),
);
