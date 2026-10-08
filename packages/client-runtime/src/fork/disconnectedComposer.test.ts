import { describe, expect, it } from "vite-plus/test";
import { createDisconnectedComposerQueue } from "./disconnectedComposer.ts";

describe("disconnected composer sends", () => {
  it("keeps original intent, IDs and attachments, then drains FIFO once on reconnect", async () => {
    const queue = createDisconnectedComposerQueue<{
      commandId: string;
      messageId: string;
      mode: string;
      attachments: string[];
    }>();
    const first = {
      commandId: "send-1",
      messageId: "message-1",
      mode: "steer",
      attachments: ["upload-1"],
    };
    const second = { commandId: "send-2", messageId: "message-2", mode: "queue", attachments: [] };
    queue.enqueue(first);
    queue.enqueue({ ...first });
    queue.enqueue(second);
    expect(queue.pending()).toEqual([first, second]);
    const sent: (typeof first)[] = [];
    let release!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = queue.flush(async (command) => {
      sent.push(command);
      if (command === first) await acknowledged;
    });
    expect(
      queue.flush(async () => {
        throw new Error("duplicate drainer");
      }),
    ).toBe(flush);
    await Promise.resolve();
    expect(sent[0]).toBe(first);
    expect(queue.pending()).toEqual([first, second]);
    release();
    await flush;
    expect(sent).toEqual([first, second]);
    expect(sent[1]).toBe(second);
    expect(queue.pending()).toEqual([]);
  });

  it("retains an ambiguous send for an explicit reconnect retry with the same identity", async () => {
    const queue = createDisconnectedComposerQueue<{ commandId: string; text: string }>();
    const command = { commandId: "stable-send", text: "hello" };
    queue.enqueue(command);
    await expect(
      queue.flush(async () => {
        throw new Error("socket closed before acknowledgement");
      }),
    ).rejects.toThrow("socket closed");
    expect(queue.pending()[0]).toBe(command);
    const delivered: (typeof command)[] = [];
    await queue.flush(async (retry) => {
      delivered.push(retry);
    });
    expect(delivered[0]).toBe(command);
    expect(queue.pending()).toEqual([]);
  });

  it("refuses conflicting reuse of a queued send identity", () => {
    const queue = createDisconnectedComposerQueue<{ commandId: string; text: string }>();
    queue.enqueue({ commandId: "same", text: "first" });
    expect(() => queue.enqueue({ commandId: "same", text: "different" })).toThrow("reused");
    expect(queue.pending()).toEqual([{ commandId: "same", text: "first" }]);
  });
});
