import { describe, expect, it } from "vite-plus/test";

import { canHoldSendWhileDisconnected, disconnectedDispatchMode } from "./disconnectedSend.logic";

const plain = {
  isExistingServerThread: true,
  isFirstMessage: false,
  text: "  keep going  ",
  attachmentCount: 0,
  contextCount: 0,
  multipleModels: false,
  answeringPrompt: false,
  editingQueuedMessage: false,
};

describe("holding a send while the server is down", () => {
  it("holds plain text on an existing thread", () => {
    expect(canHoldSendWhileDisconnected(plain)).toBe(true);
  });

  it.each([
    ["a new thread", { isExistingServerThread: false }],
    ["a first message", { isFirstMessage: true }],
    ["an empty message", { text: "   " }],
    ["a slash command", { text: "/compact" }],
    ["an attachment", { attachmentCount: 1 }],
    ["a context chip", { contextCount: 1 }],
    ["several models", { multipleModels: true }],
    ["an answer to a prompt", { answeringPrompt: true }],
    ["an edit of a queued message", { editingQueuedMessage: true }],
  ])("does not hold %s", (_, change) => {
    expect(canHoldSendWhileDisconnected({ ...plain, ...change })).toBe(false);
  });

  it("queues instead of steering or restarting a run the restart will end", () => {
    expect(disconnectedDispatchMode("steer")).toBe("queue");
    expect(disconnectedDispatchMode("restart")).toBe("queue");
    expect(disconnectedDispatchMode("auto")).toBe("auto");
  });
});
