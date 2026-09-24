import { describe, expect, it } from "vite-plus/test";

import { queuedMessageForEmptyEnter } from "./queuedMessageEnter";
import type { QueuedComposerMessage } from "./queuedMessageStore";

function queued(id: string): QueuedComposerMessage {
  return {
    id,
    prompt: `prompt ${id}`,
    images: [],
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    submissionIntent: "foreground",
    queuedAfterToolActivityId: null,
    createdAt: "2026-09-24T00:00:00.000Z",
  };
}

const emptyComposer = {
  sendingQueuedMessage: false,
  hasSendableContent: false,
  expiredTerminalContextCount: 0,
};

describe("queuedMessageForEmptyEnter", () => {
  it("sends the oldest queued message when Enter hits an empty composer", () => {
    const queue = [queued("first"), queued("second")];
    expect(queuedMessageForEmptyEnter({ ...emptyComposer, queue })?.id).toBe("first");
  });

  it("sends a message held for user action, since Enter is that action", () => {
    const held = { ...queued("held"), holdUntilUserAction: true };
    expect(queuedMessageForEmptyEnter({ ...emptyComposer, queue: [held] })?.id).toBe("held");
  });

  it("does nothing when the queue is empty", () => {
    expect(queuedMessageForEmptyEnter({ ...emptyComposer, queue: [] })).toBeNull();
  });

  it("leaves a composer with content to queue or send it normally", () => {
    const result = queuedMessageForEmptyEnter({
      ...emptyComposer,
      hasSendableContent: true,
      queue: [queued("first")],
    });
    expect(result).toBeNull();
  });

  it("keeps the expired-context warning instead of sending the queue", () => {
    const result = queuedMessageForEmptyEnter({
      ...emptyComposer,
      expiredTerminalContextCount: 1,
      queue: [queued("first")],
    });
    expect(result).toBeNull();
  });

  it("does not redirect a queued send to another queued message", () => {
    const result = queuedMessageForEmptyEnter({
      ...emptyComposer,
      sendingQueuedMessage: true,
      queue: [queued("first")],
    });
    expect(result).toBeNull();
  });
});
