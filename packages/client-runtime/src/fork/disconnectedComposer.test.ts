import { describe, expect, it, vi } from "vite-plus/test";
import {
  createDisconnectedComposerQueue,
  DisconnectedComposerRefusal,
} from "./disconnectedComposer.ts";

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

  describe("a server refusal", () => {
    type Send = { commandId: string; thread: string };
    const makeQueue = () =>
      createDisconnectedComposerQueue<Send>({ orderKey: (command) => command.thread });

    it("is terminal for that command, never replayed, while other threads still send", async () => {
      const queue = makeQueue();
      const refused = { commandId: "a1", thread: "a" };
      const behind = { commandId: "a2", thread: "a" };
      const other = { commandId: "b1", thread: "b" };
      for (const command of [refused, behind, other]) queue.enqueue(command);

      const sent: string[] = [];
      const refuse = async (command: Send) => {
        sent.push(command.commandId);
        if (command === refused) throw new DisconnectedComposerRefusal("no running turn");
      };
      await queue.flush(refuse);
      // The later message of the SAME thread waits; the other thread went on past the refusal.
      expect(sent).toEqual(["a1", "b1"]);
      expect(queue.pending()).toEqual([refused, behind]);
      expect(queue.refusal("a1")).toBe("no running turn");
      expect(queue.refusal("a2")).toBeUndefined();

      // A later flush does not replay the refused id and keeps the one behind it waiting.
      await queue.flush(refuse);
      expect(sent).toEqual(["a1", "b1"]);
    });

    it("lets the thread go on once the refused command is removed or replaced in place", async () => {
      const queue = makeQueue();
      const refused = { commandId: "a1", thread: "a" };
      const behind = { commandId: "a2", thread: "a" };
      queue.enqueue(refused);
      queue.enqueue(behind);
      await queue.flush(async (command) => {
        if (command === refused) throw new DisconnectedComposerRefusal("nope");
      });

      const resent = { commandId: "a1-again", thread: "a" };
      queue.replace("a1", resent);
      expect(queue.refusal("a1")).toBeUndefined();
      const sent: string[] = [];
      await queue.flush(async (command) => void sent.push(command.commandId));
      // Replaced in its old place, so it still goes before the message that waited behind it.
      expect(sent).toEqual(["a1-again", "a2"]);

      const second = makeQueue();
      second.enqueue(refused);
      second.enqueue(behind);
      await second.flush(async (command) => {
        if (command === refused) throw new DisconnectedComposerRefusal("nope");
      });
      expect(second.remove("a1")).toBe(true);
      expect(second.remove("a1")).toBe(false);
      expect(second.refusal("a1")).toBeUndefined();
      await second.flush(async () => undefined);
      expect(second.pending()).toEqual([]);
    });

    it("keeps a transport failure retryable with the same command and stops the drain", async () => {
      const queue = makeQueue();
      const first = { commandId: "a1", thread: "a" };
      const other = { commandId: "b1", thread: "b" };
      queue.enqueue(first);
      queue.enqueue(other);
      await expect(
        queue.flush(async () => {
          throw new Error("socket closed before acknowledgement");
        }),
      ).rejects.toThrow("socket closed");
      expect(queue.refusal("a1")).toBeUndefined();
      expect(queue.pending()).toEqual([first, other]);
    });
  });
});

it("releases single-flight after a lost acknowledgement and retries the original identity", async () => {
  vi.useFakeTimers();
  try {
    const queue = createDisconnectedComposerQueue<{ commandId: string; messageId: string }>({
      sendTimeoutMs: 50,
    });
    const command = { commandId: "same-command", messageId: "same-message" };
    queue.enqueue(command);
    let acknowledge!: () => void;
    const draining = queue.flush(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const rejection = expect(draining).rejects.toThrow("acknowledgement timed out");
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(queue.pending()).toEqual([command]);
    const delivered: (typeof command)[] = [];
    await queue.flush(async (entry) => void delivered.push(entry));
    acknowledge();
    expect(delivered).toEqual([command]);
    expect(queue.pending()).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
it("publishes the remaining count after each acknowledgement", async () => {
  const counts: number[] = [];
  const queue = createDisconnectedComposerQueue<{ commandId: string }>({
    onChange: () => counts.push(queue.pending().length),
  });
  queue.enqueue({ commandId: "a" });
  queue.enqueue({ commandId: "b" });
  await queue.flush(async () => undefined);
  expect(counts).toEqual([1, 0]);
});
