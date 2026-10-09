import {
  EventId,
  type CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type ProviderThreadId,
  type ProviderTurnId,
  type TurnItemId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";

const active = (status: string) =>
  ["queued", "preparing", "starting", "running", "waiting"].includes(status);

/** Records Stop ACK separately; only the delayed fallback settles missing native finalization. */
export function interruptedSessionEvents(input: {
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    | "thread"
    | "runs"
    | "attempts"
    | "nodes"
    | "turnItems"
    | "providerThreads"
    | "providerTurns"
    | "providerSessions"
  >;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly commandId: CommandId;
  readonly now: DateTime.Utc;
  readonly resultItemId?: TurnItemId | undefined;
  readonly acknowledgeOnly?: boolean;
}): OrchestrationV2DomainEvent[] {
  const p = input.projection;
  const providerThread = p.providerThreads.find((thread) => thread.id === input.providerThreadId);
  const turn = p.providerTurns.find((turn) => turn.id === input.providerTurnId);
  const attempt = p.attempts.find((attempt) => attempt.id === turn?.runAttemptId);
  const run = p.runs.find((run) => run.id === attempt?.runId);
  const session = p.providerSessions.find(
    (session) => session.id === providerThread?.providerSessionId,
  );
  if (!run || !attempt || !turn || !providerThread || !session) return [];
  if (run.activeAttemptId !== attempt.id || providerThread.lastRunOrdinal !== run.ordinal)
    return [];
  if (p.runs.some((other) => other.id !== run.id && active(other.status))) return [];
  if (input.acknowledgeOnly) {
    const request = p.turnItems.find(
      (item) => item.runId === run.id && item.type === "run_interrupt_request",
    );
    return request?.type === "run_interrupt_request"
      ? [
          {
            id: EventId.make(`${input.commandId}:ack`),
            type: "turn-item.updated",
            threadId: p.thread.id,
            runId: run.id,
            occurredAt: input.now,
            payload: {
              ...request,
              stopOutcome: "ack",
              title: "Stop acknowledged",
              updatedAt: input.now,
            },
          },
        ]
      : [];
  }
  // A native terminal receipt may precede its checkpoint and run settlement.
  // Preserve that native outcome while finalization is still in progress.
  if (active(run.status) && !active(turn.status)) return [];
  const events: OrchestrationV2DomainEvent[] = [];
  const base = {
    threadId: p.thread.id,
    runId: run.id,
    providerInstanceId: run.providerInstanceId,
    occurredAt: input.now,
  };
  if (active(run.status)) {
    const interruptRequest = p.turnItems.find(
      (item) => item.runId === run.id && item.type === "run_interrupt_request",
    );
    if (!interruptRequest) return [];
    if (input.resultItemId)
      events.push({
        ...base,
        id: EventId.make(`${input.commandId}:result`),
        type: "turn-item.updated",
        payload: {
          id: input.resultItemId,
          threadId: p.thread.id,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: providerThread.id,
          providerTurnId: turn.id,
          nativeItemRef: null,
          parentItemId: interruptRequest.id,
          ordinal: interruptRequest.ordinal + 1,
          status: "interrupted",
          title: "Interrupted",
          startedAt: input.now,
          completedAt: input.now,
          updatedAt: input.now,
          type: "run_interrupt_result",
          stopOutcome: "fallback",
          message: "Run interrupted by user",
        },
      });
    events.push({
      ...base,
      id: EventId.make(`${input.commandId}:run`),
      type: "run.updated",
      payload: { ...run, status: "interrupted", completedAt: input.now },
    });
    events.push({
      ...base,
      id: EventId.make(`${input.commandId}:attempt`),
      type: "run-attempt.updated",
      payload: { ...attempt, status: "interrupted", completedAt: input.now },
    });
    for (const node of p.nodes.filter((node) => node.runId === run.id && active(node.status)))
      events.push({
        ...base,
        nodeId: node.id,
        id: EventId.make(`${input.commandId}:node:${node.id}`),
        type: "node.updated",
        payload: { ...node, status: "interrupted", completedAt: input.now },
      });
    events.push({
      ...base,
      id: EventId.make(`${input.commandId}:turn`),
      type: "provider-turn.updated",
      payload: { ...turn, status: "interrupted", completedAt: input.now },
    });
    events.push({
      ...base,
      id: EventId.make(`${input.commandId}:provider-thread`),
      type: "provider-thread.updated",
      payload: {
        ...providerThread,
        status: "idle",
        updatedAt: input.now,
        pendingBackgroundTasks: [],
      },
    });
  }
  if (["starting", "running", "waiting"].includes(session.status))
    events.push({
      ...base,
      driver: session.driver,
      id: EventId.make(`${input.commandId}:session`),
      type: "provider-session.updated",
      payload: {
        ...session,
        status: run.status === "failed" ? "error" : "ready",
        lastError: run.status === "failed" ? session.lastError : null,
        updatedAt: input.now,
      },
    });
  return events;
}
