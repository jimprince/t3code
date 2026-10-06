import { expect, it } from "vite-plus/test";
import { MessageId, RunId } from "@t3tools/contracts";
import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
} from "@t3tools/client-runtime/backgroundTurns";
import { foldBackgroundRows } from "./OrchestratorFocus";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

it("folds settled worker messages and work reversibly without hiding subsequent user traffic", () => {
  const messages = [
    {
      id: MessageId.make("u"),
      role: "user" as const,
      text: "notice",
      senderThreadId: "child",
      runId: RunId.make("r"),
      createdAt: "1",
      updatedAt: "1",
      streaming: false,
    },
    {
      id: MessageId.make("a"),
      role: "assistant" as const,
      text: "Done",
      runId: RunId.make("r"),
      createdAt: "2",
      updatedAt: "2",
      streaming: false,
    },
  ];
  const traffic = deriveBackgroundTraffic({
    messages,
    workerThreadIds: new Set(["child"]),
    attentionTurnIds: new Set(),
    liveTurnId: null,
  });
  const rows = messages.map(
    (message) =>
      ({
        kind: "message",
        id: message.id,
        createdAt: message.createdAt,
        message,
        durationStart: message.createdAt,
        showAssistantMeta: false,
        showAssistantCopyButton: false,
        assistantCopyStreaming: false,
      }) as MessagesTimelineRow,
  );
  const folded = foldBackgroundRows(
    rows,
    resolveBackgroundFolds(traffic.runs, new Set()),
    () => {},
  );
  expect(folded.map((row) => row.kind)).toEqual(["background-fold"]);
  const expanded = foldBackgroundRows(
    rows,
    resolveBackgroundFolds(traffic.runs, new Set([traffic.runs[0]!.id])),
    () => {},
  );
  expect(expanded.filter((row) => row.kind === "message").map((row) => row.id)).toEqual(["u", "a"]);
});
