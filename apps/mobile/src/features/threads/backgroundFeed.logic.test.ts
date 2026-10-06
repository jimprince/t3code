import { expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  resolveBackgroundFolds,
  type BackgroundTraffic,
} from "@t3tools/client-runtime/backgroundTurns";
import { applyBackgroundFolds, deriveMobileBackgroundTraffic } from "./backgroundFeed.logic";
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
    previous: null as BackgroundTraffic | null,
  };
  const traffic = deriveMobileBackgroundTraffic(input);
  const folds = (expanded: ReadonlySet<string>, from = traffic) =>
    from.runs.length > 0 ? resolveBackgroundFolds(from.runs, expanded) : null;
  const collapsed = applyBackgroundFolds(feed, folds(new Set()));
  expect(collapsed.map((entry) => entry.type)).toEqual(["background-fold"]);
  const [fold] = collapsed;
  expect(fold?.type === "background-fold" && fold.expanded).toBe(false);
  expect(applyBackgroundFolds(feed, null)).toBe(feed);
  const live = deriveMobileBackgroundTraffic({ ...input, liveRunId: "r" });
  expect(applyBackgroundFolds(feed, folds(new Set(), live)).map((entry) => entry.type)).toEqual([
    "message",
    "message",
  ]);
  const expanded = applyBackgroundFolds(feed, folds(new Set([traffic.runs[0]!.id])));
  expect(expanded.map((entry) => entry.type)).toEqual(["background-fold", "message", "message"]);

  // Re-deriving the same feed keeps the traffic object, so folds and rows stay put while streaming.
  expect(deriveMobileBackgroundTraffic({ ...input, previous: traffic })).toBe(traffic);
});
