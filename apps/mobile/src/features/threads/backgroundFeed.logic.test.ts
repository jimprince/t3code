import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
} from "@t3tools/client-runtime/background-turns";
import { MessageId, TurnId, type OrchestrationThread } from "@t3tools/contracts";
import { makeMessageOriginContext } from "@t3tools/shared/messageOrigin";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { applyBackgroundFolds } from "./backgroundFeed.logic";

type Message = OrchestrationThread["messages"][number];

function message(
  id: string,
  role: "user" | "assistant",
  second: number,
  extra: Partial<Message> = {},
) {
  const createdAt = new Date(Date.UTC(2026, 9, 2, 0, 0, second)).toISOString();
  return {
    id: MessageId.make(id),
    role,
    text: role === "user" ? "Calibrate the arm" : "On it.",
    turnId: role === "assistant" ? TurnId.make(`turn-${id}`) : null,
    streaming: false,
    createdAt,
    updatedAt: createdAt,
    ...extra,
  } as Message;
}

const messages = [
  message("brad", "user", 0),
  message("reply", "assistant", 1),
  message("notice", "user", 2, {
    text: "T3 orchestrator notification: arm-calib completed a turn.",
    context: makeMessageOriginContext({ source: "worker-notification", fromName: "arm-calib" }),
  } as Partial<Message>),
  message("relay", "assistant", 3),
];

const feed: ThreadFeedEntry[] = messages.map((entry) => ({
  type: "message",
  id: entry.id,
  createdAt: entry.createdAt,
  message: entry,
}));
const { runs } = deriveBackgroundTraffic({
  messages,
  workerThreadIds: new Set(),
  attentionTurnIds: new Set(),
  liveTurnId: null,
});

describe("applyBackgroundFolds", () => {
  it("folds the worker run behind one row and restores it when expanded", () => {
    const ids = (expanded: ReadonlySet<string>) =>
      applyBackgroundFolds(feed, resolveBackgroundFolds(runs, expanded)).map((entry) => entry.id);

    expect(ids(new Set())).toEqual(["brad", "reply", "background:notice"]);
    expect(ids(new Set(["background:notice"]))).toEqual([
      "brad",
      "reply",
      "background:notice",
      "notice",
      "relay",
    ]);
  });
});
