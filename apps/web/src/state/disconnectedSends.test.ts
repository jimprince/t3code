import { CommandId, EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  disconnectedFlushRequests,
  enqueueDisconnectedSend,
  flushHeldSends,
  isDisconnectedSendsRefused,
  resetDisconnectedSendsForTest,
  retryDisconnectedSends,
  type DisconnectedSend,
} from "./disconnectedSends";

const environment = EnvironmentId.make("environment-a");
const thread = ThreadId.make("thread-a");

const held = (id: string): DisconnectedSend =>
  ({
    commandId: CommandId.make(`command-${id}`),
    threadId: thread,
    message: {
      messageId: MessageId.make(`message-${id}`),
      role: "user",
      text: id,
      attachments: [],
    },
  }) as unknown as DisconnectedSend;

describe("held sends", () => {
  beforeEach(resetDisconnectedSendsForTest);

  it("delivers in order, the earlier held message before one enqueued later", async () => {
    const delivered: string[] = [];
    enqueueDisconnectedSend(environment, held("a"));
    enqueueDisconnectedSend(environment, held("b"));
    await flushHeldSends(
      [environment],
      async (_, command) => void delivered.push(command.commandId),
    );
    expect(delivered).toEqual(["command-a", "command-b"]);
  });

  it("asks for delivery when a send is held, so one held while connected does not wait", () => {
    const before = disconnectedFlushRequests();
    enqueueDisconnectedSend(environment, held("a"));
    expect(disconnectedFlushRequests()).toBe(before + 1);
  });

  it("keeps a refused message, marks the environment and replays the same command on Retry", async () => {
    const seen: DisconnectedSend[] = [];
    const first = held("a");
    enqueueDisconnectedSend(environment, first);
    enqueueDisconnectedSend(environment, held("b"));
    await flushHeldSends([environment], async (_, command) => {
      seen.push(command);
      throw new Error("refused");
    });
    // The second message is not attempted past the refused first one, and nothing loops.
    expect(seen.map((command) => command.commandId)).toEqual(["command-a"]);
    expect(isDisconnectedSendsRefused(environment)).toBe(true);

    const requests = disconnectedFlushRequests();
    retryDisconnectedSends(environment);
    expect(isDisconnectedSendsRefused(environment)).toBe(false);
    expect(disconnectedFlushRequests()).toBe(requests + 1);
    await flushHeldSends([environment], async (_, command) => void seen.push(command));
    expect(seen.map((command) => command.commandId)).toEqual([
      "command-a",
      "command-a",
      "command-b",
    ]);
    expect(seen[1]).toBe(first);
    expect(isDisconnectedSendsRefused(environment)).toBe(false);
  });
});
