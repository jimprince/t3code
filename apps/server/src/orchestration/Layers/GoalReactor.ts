import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { GoalReactor, type GoalReactorShape } from "../Services/GoalReactor.ts";

type TurnCompletedEvent = Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>;

const MAX_GOAL_CONTINUATIONS = 8;
const GOAL_TRANSCRIPT_MAX_CHARS = 60_000;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const serverMessageId = (tag: string): MessageId =>
  MessageId.make(`server:${tag}:${crypto.randomUUID()}`);

function buildGoalTranscript(messages: ReadonlyArray<OrchestrationMessage>): string {
  const transcript = messages
    .filter((message) => !message.streaming)
    .map((message) => `${message.role.toUpperCase()}: ${message.text.trim()}`)
    .join("\n\n");
  return transcript.length <= GOAL_TRANSCRIPT_MAX_CHARS
    ? transcript
    : transcript.slice(transcript.length - GOAL_TRANSCRIPT_MAX_CHARS);
}

function buildContinuationPrompt(goal: string, reason: string): string {
  return [
    `Continue working toward this active T3 goal: ${goal}`,
    "",
    `Latest transcript-only evaluator result: ${reason}`,
    "",
    "Continue from the current state. Make progress, run appropriate verification, and clearly state transcript-visible evidence when the goal is satisfied. If blocked on approval or user input, ask explicitly instead of guessing.",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;

  const processTurnCompleted = Effect.fn("processGoalTurnCompleted")(function* (
    event: TurnCompletedEvent,
  ) {
    if (event.payload.status !== "ready") return;

    const shell = yield* projectionSnapshotQuery
      .getThreadShellById(event.payload.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!shell?.goal || shell.goal.status !== "active") return;
    if (shell.goal.lastTurnId === event.payload.turnId) return;
    if (shell.hasPendingApprovals || shell.hasPendingUserInput) return;
    if (shell.session?.status === "error" || shell.session?.lastError) return;
    if (
      shell.latestTurn?.turnId !== event.payload.turnId ||
      shell.latestTurn.state !== "completed"
    ) {
      return;
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(event.payload.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread?.goal || thread.goal.status !== "active") return;

    const { textGenerationModelSelection } = yield* serverSettings.getSettings;
    const evaluated = yield* textGeneration.evaluateGoal({
      cwd: process.cwd(),
      goal: thread.goal.goal,
      transcript: buildGoalTranscript(thread.messages),
      modelSelection: textGenerationModelSelection,
    });

    const continuationRequested =
      !evaluated.achieved && thread.goal.continuationCount < MAX_GOAL_CONTINUATIONS;
    const evaluatedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

    yield* orchestrationEngine.dispatch({
      type: "thread.goal.evaluation.record",
      commandId: serverCommandId("goal-evaluation-record"),
      threadId: event.payload.threadId,
      turnId: event.payload.turnId,
      achieved: evaluated.achieved,
      reason: evaluated.reason,
      continuationRequested,
      createdAt: evaluatedAt,
    });

    if (!continuationRequested) return;

    const prompt = buildContinuationPrompt(thread.goal.goal, evaluated.reason);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: serverCommandId("goal-continuation-turn"),
      threadId: event.payload.threadId,
      message: {
        messageId: serverMessageId("goal-continuation-message"),
        role: "user",
        text: prompt,
        attachments: [],
      },
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      createdAt: evaluatedAt,
    });
  });

  const processSafely = (event: TurnCompletedEvent) =>
    processTurnCompleted(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("goal reactor failed to process completed turn", {
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processSafely);

  const start: GoalReactorShape["start"] = Effect.fn("GoalReactor.start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.turn-diff-completed" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies GoalReactorShape;
});

export const GoalReactorLive = Layer.effect(GoalReactor, make);
