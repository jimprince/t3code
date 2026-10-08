import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2DispatchCommandError,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  disconnectedFlushRequests,
  disconnectedSendRefusals,
  discardDisconnectedSend,
  enqueueDisconnectedSend,
  flushHeldSends,
  isDisconnectedSendsStalled,
  pendingDisconnectedSends,
  resendDisconnectedSend,
  resetDisconnectedSendsForTest,
  retryDisconnectedSends,
  type DisconnectedSend,
} from "./disconnectedSends";

const environment = EnvironmentId.make("environment-a");
const thread = ThreadId.make("thread-a");

const otherThread = ThreadId.make("thread-b");

/** What the server answers when it decides no, as opposed to a socket that dropped. */
const refusal = (command: DisconnectedSend, message = "No running provider turn found") =>
  new OrchestrationV2DispatchCommandError({
    commandId: command.commandId,
    commandType: "message.dispatch",
    message,
  });

const held = (id: string, threadId = thread): DisconnectedSend =>
  ({
    commandId: CommandId.make(`command-${id}`),
    threadId,
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

  it("shows a thread's held messages until the server accepts them", async () => {
    const texts = () =>
      pendingDisconnectedSends(environment, thread).map((send) => send.message.text);
    enqueueDisconnectedSend(environment, held("a"));
    enqueueDisconnectedSend(environment, held("b"));
    enqueueDisconnectedSend(environment, held("other", ThreadId.make("thread-b")));
    expect(texts()).toEqual(["a", "b"]);

    await flushHeldSends([environment], async () => {
      throw new Error("refused");
    });
    expect(texts()).toEqual(["a", "b"]);

    await flushHeldSends([environment], async () => undefined);
    expect(texts()).toEqual([]);
  });

  it("asks for delivery when a send is held, so one held while connected does not wait", () => {
    const before = disconnectedFlushRequests();
    enqueueDisconnectedSend(environment, held("a"));
    expect(disconnectedFlushRequests()).toBe(before + 1);
  });

  it("keeps a transport failure held under the same command, marks the environment stalled and replays on Retry", async () => {
    const seen: DisconnectedSend[] = [];
    const first = held("a");
    enqueueDisconnectedSend(environment, first);
    enqueueDisconnectedSend(environment, held("b"));
    await flushHeldSends([environment], async (_, command) => {
      seen.push(command);
      throw new Error("socket closed before acknowledgement");
    });
    // A transit failure stops delivery; nothing loops and nothing is marked refused.
    expect(seen.map((command) => command.commandId)).toEqual(["command-a"]);
    expect(isDisconnectedSendsStalled(environment)).toBe(true);
    expect(disconnectedSendRefusals(environment)).toEqual({});

    const requests = disconnectedFlushRequests();
    retryDisconnectedSends(environment);
    expect(isDisconnectedSendsStalled(environment)).toBe(false);
    expect(disconnectedFlushRequests()).toBe(requests + 1);
    await flushHeldSends([environment], async (_, command) => void seen.push(command));
    expect(seen.map((command) => command.commandId)).toEqual([
      "command-a",
      "command-a",
      "command-b",
    ]);
    expect(seen[1]).toBe(first);
  });

  describe("a server refusal", () => {
    const refuseCommand = (id: string) => async (_: unknown, command: DisconnectedSend) => {
      if (command.commandId === `command-${id}`) throw refusal(command, `refused ${id}`);
    };

    it("is terminal for that message and does not block another thread's held sends", async () => {
      const delivered: string[] = [];
      enqueueDisconnectedSend(environment, held("a"));
      enqueueDisconnectedSend(environment, held("b", otherThread));
      await flushHeldSends([environment], async (environmentId, command) => {
        delivered.push(command.commandId);
        await refuseCommand("a")(environmentId, command);
      });
      expect(delivered).toEqual(["command-a", "command-b"]);
      expect(disconnectedSendRefusals(environment)).toEqual({ "command-a": "refused a" });
      expect(pendingDisconnectedSends(environment, otherThread)).toEqual([]);
      expect(isDisconnectedSendsStalled(environment)).toBe(false);

      // The refused command id is not replayed by a later flush or a Retry.
      retryDisconnectedSends(environment);
      await flushHeldSends(
        [environment],
        async (_, command) => void delivered.push(command.commandId),
      );
      expect(delivered).toEqual(["command-a", "command-b"]);
    });

    it("holds a later message of the same thread behind it, then Resend sends both in order under a new id", async () => {
      const delivered: DisconnectedSend[] = [];
      const record = async (environmentId: EnvironmentId, command: DisconnectedSend) => {
        delivered.push(command);
        await refuseCommand("a")(environmentId, command);
      };
      enqueueDisconnectedSend(environment, held("a"));
      enqueueDisconnectedSend(environment, held("b"));
      await flushHeldSends([environment], record);
      expect(delivered.map((command) => command.commandId)).toEqual(["command-a"]);

      const requests = disconnectedFlushRequests();
      resendDisconnectedSend(environment, CommandId.make("command-a"));
      expect(disconnectedFlushRequests()).toBe(requests + 1);
      expect(disconnectedSendRefusals(environment)).toEqual({});
      const [resent, behind] = pendingDisconnectedSends(environment, thread);
      expect(resent!.message.text).toBe("a");
      expect(resent!.commandId).not.toBe("command-a");
      expect(resent!.message.messageId).not.toBe("message-a");
      expect(behind!.commandId).toBe("command-b");

      delivered.length = 0;
      await flushHeldSends([environment], async (_, command) => void delivered.push(command));
      expect(delivered.map((command) => command.message.text)).toEqual(["a", "b"]);
      expect(delivered[0]!.commandId).toBe(resent!.commandId);
      expect(pendingDisconnectedSends(environment, thread)).toEqual([]);
    });

    it("Discard removes the message and lets the thread's later messages go", async () => {
      enqueueDisconnectedSend(environment, held("a"));
      enqueueDisconnectedSend(environment, held("b"));
      await flushHeldSends([environment], refuseCommand("a"));
      expect(pendingDisconnectedSends(environment, thread)).toHaveLength(2);

      const requests = disconnectedFlushRequests();
      discardDisconnectedSend(environment, CommandId.make("command-a"));
      expect(disconnectedFlushRequests()).toBe(requests + 1);
      expect(
        pendingDisconnectedSends(environment, thread).map((send) => send.message.text),
      ).toEqual(["b"]);
      expect(disconnectedSendRefusals(environment)).toEqual({});

      const delivered: string[] = [];
      await flushHeldSends(
        [environment],
        async (_, command) => void delivered.push(command.message.text),
      );
      expect(delivered).toEqual(["b"]);
    });
  });
});
