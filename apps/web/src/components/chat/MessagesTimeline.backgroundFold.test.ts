import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
} from "@t3tools/client-runtime/background-turns";
import { MessageId, TurnId } from "@t3tools/contracts";
import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";
import { describe, expect, it } from "vite-plus/test";

import { deriveTimelineEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";

const time = (second: number) => new Date(Date.UTC(2026, 9, 2, 0, 0, second)).toISOString();

function message(
  id: string,
  role: "user" | "assistant",
  second: number,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  return {
    id: MessageId.make(id),
    role,
    text: role === "user" ? "Plan the arm calibration" : "On it.",
    turnId: role === "assistant" ? TurnId.make(`turn-${id}`) : null,
    createdAt: time(second),
    updatedAt: time(second),
    streaming: false,
    ...overrides,
  };
}

const messages: ChatMessage[] = [
  message("brad", "user", 0),
  message("reply", "assistant", 1),
  message("notice", "user", 2, {
    text: "T3 orchestrator notification: arm-calib completed a turn.",
    context: makeMessageOriginContext({ source: "worker-notification", fromName: "arm-calib" }),
  }),
  message("relay", "assistant", 3, { text: "Sent arm-calib the follow-up." }),
];

function rows(expanded: ReadonlySet<string>) {
  const { runs } = deriveBackgroundTraffic({
    messages,
    workerThreadIds: new Set(),
    attentionTurnIds: new Set(),
    liveTurnId: null,
  });
  return deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntries(messages, [], []),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    backgroundFolds: resolveBackgroundFolds(runs, expanded),
  });
}

describe("background folds in the timeline", () => {
  it("replaces a worker run with one fold row and keeps the user's own turn", () => {
    const collapsed = rows(new Set());
    const messageIds = collapsed.flatMap((row) => (row.kind === "message" ? [row.message.id] : []));
    const fold = collapsed.find((row) => row.kind === "background-fold");

    expect(messageIds).toEqual(["brad", "reply"]);
    expect(fold).toMatchObject({
      expanded: false,
      run: { turnCount: 1, senderLabels: ["arm-calib"] },
    });
  });

  it("shows the run's messages under its fold row once expanded", () => {
    const expanded = rows(new Set(["background:notice"]));
    const kinds = expanded.flatMap((row) =>
      row.kind === "message" ? [row.message.id] : row.kind === "background-fold" ? ["fold"] : [],
    );

    expect(kinds).toEqual(["brad", "reply", "fold", "notice", "relay"]);
  });
});
