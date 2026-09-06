import {
  CheckpointRef,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveThreadForkBoundary } from "./threadFork.ts";

const threadId = ThreadId.make("thread-source");
const createdAt = "2026-07-19T12:00:00.000Z";

function message(input: {
  id: string;
  role: "user" | "assistant";
  turnId: string;
  text: string;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: TurnId.make(input.turnId),
    streaming: false,
    createdAt,
    updatedAt: createdAt,
  };
}

function checkpoint(input: {
  turn: number;
  turnId: string;
  assistantMessageId: string;
}): OrchestrationCheckpointSummary {
  return {
    turnId: TurnId.make(input.turnId),
    checkpointTurnCount: input.turn,
    checkpointRef: CheckpointRef.make(`refs/t3/checkpoints/${threadId}/turn/${input.turn}`),
    status: "ready",
    files: [],
    assistantMessageId: MessageId.make(input.assistantMessageId),
    completedAt: createdAt,
  };
}

const messages = [
  message({ id: "user-1", role: "user", turnId: "turn-1", text: "First request" }),
  message({ id: "assistant-1", role: "assistant", turnId: "turn-1", text: "First answer" }),
  message({ id: "user-2", role: "user", turnId: "turn-2", text: "Second request" }),
  message({ id: "assistant-2", role: "assistant", turnId: "turn-2", text: "Second answer" }),
];
const checkpoints = [
  checkpoint({ turn: 1, turnId: "turn-1", assistantMessageId: "assistant-1" }),
  checkpoint({ turn: 2, turnId: "turn-2", assistantMessageId: "assistant-2" }),
];

describe("resolveThreadForkBoundary", () => {
  it("retains an assistant message and its completed turn", () => {
    const boundary = resolveThreadForkBoundary({
      messages,
      checkpoints,
      messageId: MessageId.make("assistant-1"),
    });

    expect(boundary.retainedMessages.map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
    expect(boundary.retainedTurnCount).toBe(1);
    expect(boundary.retainedTurnId).toBe(TurnId.make("turn-1"));
    expect(boundary.checkpointRef).toBe(checkpoints[0]!.checkpointRef);
    expect(boundary.checkpointTurnCount).toBe(1);
    expect(boundary.prefilledPrompt).toBeNull();
  });

  it("retains the whole completed turn when an earlier assistant update is selected", () => {
    const assistantUpdate = message({
      id: "assistant-update",
      role: "assistant",
      turnId: "turn-1",
      text: "Working on it",
    });
    const boundary = resolveThreadForkBoundary({
      messages: [messages[0]!, assistantUpdate, ...messages.slice(1)],
      checkpoints,
      messageId: assistantUpdate.id,
    });

    expect(boundary.retainedMessages.map((entry) => entry.id)).toEqual([
      "user-1",
      "assistant-update",
      "assistant-1",
    ]);
    expect(boundary.retainedTurnCount).toBe(1);
    expect(boundary.retainedTurnId).toBe(TurnId.make("turn-1"));
    expect(boundary.checkpointRef).toBe(checkpoints[0]!.checkpointRef);
    expect(boundary.checkpointTurnCount).toBe(1);
  });

  it("forks before a user turn and returns that prompt for editing", () => {
    const attachedMessages = messages.map((entry) =>
      entry.id === MessageId.make("user-2")
        ? {
            ...entry,
            attachments: [
              {
                type: "image" as const,
                id: "fork-image",
                name: "fork.png",
                mimeType: "image/png",
                sizeBytes: 123,
              },
            ],
          }
        : entry,
    );
    const boundary = resolveThreadForkBoundary({
      messages: attachedMessages,
      checkpoints,
      messageId: MessageId.make("user-2"),
    });

    expect(boundary.retainedMessages.map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
    expect(boundary.retainedTurnCount).toBe(1);
    expect(boundary.retainedTurnId).toBe(TurnId.make("turn-1"));
    expect(boundary.checkpointTurnCount).toBe(1);
    expect(boundary.checkpointRef).toBe(checkpoints[0]!.checkpointRef);
    expect(boundary.prefilledPrompt).toBe("Second request");
    expect(boundary.prefilledAttachments).toEqual(attachedMessages[2]!.attachments);
  });

  it("uses the baseline when forking from the first user message", () => {
    const boundary = resolveThreadForkBoundary({
      messages,
      checkpoints,
      messageId: MessageId.make("user-1"),
    });

    expect(boundary.retainedMessages).toEqual([]);
    expect(boundary.retainedTurnCount).toBe(0);
    expect(boundary.retainedTurnId).toBeNull();
    expect(boundary.checkpointTurnCount).toBe(0);
    expect(boundary.checkpointRef).toBeNull();
    expect(boundary.prefilledPrompt).toBe("First request");
    expect(boundary.prefilledAttachments).toEqual([]);
  });

  it("rejects streaming and unknown messages", () => {
    expect(() =>
      resolveThreadForkBoundary({
        messages: [{ ...messages[3]!, streaming: true }],
        checkpoints,
        messageId: MessageId.make("assistant-2"),
      }),
    ).toThrow("still streaming");
    expect(() =>
      resolveThreadForkBoundary({
        messages,
        checkpoints,
        messageId: MessageId.make("missing"),
      }),
    ).toThrow("was not found");
  });
});
