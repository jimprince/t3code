import type {
  CheckpointRef,
  MessageId,
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  TurnId,
} from "@t3tools/contracts";

export interface ThreadForkBoundary {
  readonly retainedMessages: ReadonlyArray<OrchestrationMessage>;
  readonly retainedTurnCount: number;
  readonly retainedTurnId: TurnId | null;
  readonly checkpointRef: CheckpointRef | null;
  readonly checkpointTurnCount: number;
  readonly prefilledPrompt: string | null;
  readonly prefilledAttachments: NonNullable<OrchestrationMessage["attachments"]>;
}

export function resolveThreadForkBoundary(input: {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
  readonly messageId: MessageId;
}): ThreadForkBoundary {
  const selectedIndex = input.messages.findIndex((message) => message.id === input.messageId);
  if (selectedIndex < 0) {
    throw new Error(`Message '${input.messageId}' was not found.`);
  }

  const selected = input.messages[selectedIndex]!;
  if (selected.streaming) {
    throw new Error(`Message '${input.messageId}' is still streaming.`);
  }

  const retainedEndExclusive =
    selected.role === "user"
      ? selectedIndex
      : selected.turnId === null
        ? selectedIndex + 1
        : input.messages.reduce(
            (lastIndex, message, index) =>
              message.turnId === selected.turnId ? index + 1 : lastIndex,
            selectedIndex + 1,
          );
  const retainedMessages = input.messages.slice(0, retainedEndExclusive);
  const retainedMessageIds = new Set(retainedMessages.map((message) => message.id));
  const retainedTurnIds = new Set(
    retainedMessages
      .filter((message) => message.role === "assistant" && message.turnId !== null)
      .map((message) => message.turnId),
  );
  const retainedTurnId = retainedMessages.reduce<TurnId | null>(
    (latest, message) =>
      message.role === "assistant" && message.turnId !== null ? message.turnId : latest,
    null,
  );
  const retainedCheckpoint = input.checkpoints
    .filter(
      (checkpoint) =>
        checkpoint.status === "ready" &&
        checkpoint.assistantMessageId !== null &&
        retainedMessageIds.has(checkpoint.assistantMessageId),
    )
    .toSorted((left, right) => right.checkpointTurnCount - left.checkpointTurnCount)[0];

  return {
    retainedMessages,
    retainedTurnCount: retainedTurnIds.size,
    retainedTurnId,
    checkpointRef: retainedCheckpoint?.checkpointRef ?? null,
    checkpointTurnCount: retainedCheckpoint?.checkpointTurnCount ?? 0,
    prefilledPrompt: selected.role === "user" ? selected.text : null,
    prefilledAttachments: selected.role === "user" ? [...(selected.attachments ?? [])] : [],
  };
}
