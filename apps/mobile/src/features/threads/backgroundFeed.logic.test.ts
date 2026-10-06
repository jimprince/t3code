import { expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { applyBackgroundFolds, deriveMobileBackgroundFolds } from "./backgroundFeed.logic";
it("folds worker traffic to one row, expands it, and keeps live traffic visible", () => {
  const feed = [
    {
      type: "message",
      id: "u",
      createdAt: "1",
      message: {
        id: MessageId.make("u"),
        role: "user",
        text: "notice",
        senderThreadId: ThreadId.make("child"),
        runId: RunId.make("r"),
        createdAt: "1",
        streaming: false,
        updatedAt: "2",
        attachments: [],
        visibility: "local",
        sourceThreadId: ThreadId.make("root"),
      },
    },
    {
      type: "message",
      id: "a",
      createdAt: "2",
      message: {
        id: MessageId.make("a"),
        role: "assistant",
        text: "done",
        runId: RunId.make("r"),
        createdAt: "2",
        streaming: false,
        updatedAt: "2",
        attachments: [],
        visibility: "local",
        sourceThreadId: ThreadId.make("root"),
      },
    },
  ] as ReadonlyArray<ThreadFeedEntry>;
  const input = {
    feed,
    workerIds: new Set(["child"]),
    liveRunId: null,
    expanded: new Set<string>(),
  };
  const collapsed = applyBackgroundFolds(feed, deriveMobileBackgroundFolds(input).folds);
  expect(collapsed.map((entry) => entry.type)).toEqual(["background-fold"]);
  const [fold] = collapsed;
  expect(fold?.type === "background-fold" && fold.expanded).toBe(false);
  expect(applyBackgroundFolds(feed, null)).toBe(feed);
  expect(
    applyBackgroundFolds(feed, deriveMobileBackgroundFolds({ ...input, liveRunId: "r" }).folds).map(
      (entry) => entry.type,
    ),
  ).toEqual(["message", "message"]);
  const runId = deriveMobileBackgroundFolds(input).traffic.runs[0]!.id;
  const expanded = applyBackgroundFolds(
    feed,
    deriveMobileBackgroundFolds({ ...input, expanded: new Set([runId]) }).folds,
  );
  expect(expanded.map((entry) => entry.type)).toEqual(["background-fold", "message", "message"]);
});
