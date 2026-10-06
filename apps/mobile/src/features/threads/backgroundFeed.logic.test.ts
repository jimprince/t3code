import { expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { foldMobileBackgroundFeed } from "./backgroundFeed.logic";
it("restores worker messages with All traffic and keeps live/unanswered traffic", () => {
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
    allTraffic: false,
  };
  expect(foldMobileBackgroundFeed(input).feed).toEqual([]);
  expect(foldMobileBackgroundFeed({ ...input, allTraffic: true }).feed).toBe(feed);
  expect(foldMobileBackgroundFeed({ ...input, liveRunId: "r" }).feed).toEqual(feed);
});
