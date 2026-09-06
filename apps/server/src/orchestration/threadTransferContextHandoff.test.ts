import { EventId, MessageId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildTransferredThreadProviderInput,
  findPendingTransferredThreadHandoff,
} from "./threadTransferContextHandoff.ts";

const timestamp = (seconds: number) => `2026-07-17T00:00:${String(seconds).padStart(2, "0")}.000Z`;

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly seconds: number;
}) {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text,
    turnId: null,
    streaming: false,
    createdAt: timestamp(input.seconds),
    updatedAt: timestamp(input.seconds),
  } as const;
}

describe("thread transfer context handoff", () => {
  it("selects the imported history until the first provider response is recorded", () => {
    const historicalMessages = [
      message({ id: "history-user", role: "user", text: "investigate the bug", seconds: 1 }),
      message({ id: "history-assistant", role: "assistant", text: "I found it", seconds: 2 }),
    ];
    const current = message({
      id: "current-user",
      role: "user",
      text: "continue on this machine",
      seconds: 4,
    });
    const importedAt = timestamp(3);
    const thread = {
      id: ThreadId.make("thread-1"),
      messages: [...historicalMessages, current],
      activities: [
        {
          id: EventId.make("import-marker"),
          tone: "info" as const,
          kind: "thread.imported",
          summary: "Thread moved from another machine",
          payload: {
            exportedAt: timestamp(2),
            providerContextHandoff: {
              version: 1,
              required: true,
              historyMessageCount: historicalMessages.length,
            },
          },
          turnId: null,
          createdAt: importedAt,
        },
      ],
    };

    expect(
      findPendingTransferredThreadHandoff({
        thread,
        currentMessageId: current.id,
        consumedExportedAt: null,
      }),
    ).toMatchObject({
      exportedAt: timestamp(2),
      historyMessages: historicalMessages,
    });

    expect(
      findPendingTransferredThreadHandoff({
        thread,
        currentMessageId: current.id,
        consumedExportedAt: timestamp(2),
      }),
    ).toBeUndefined();

    expect(
      findPendingTransferredThreadHandoff({
        thread: {
          ...thread,
          messages: [
            ...historicalMessages,
            message({
              id: "post-import-assistant",
              role: "assistant",
              text: "resumed",
              seconds: 4,
            }),
            current,
          ],
        },
        currentMessageId: current.id,
        consumedExportedAt: null,
      }),
    ).toBeUndefined();
  });

  it("keeps recent history within the limit and includes the current request exactly once", () => {
    const currentRequest = "CURRENT_REQUEST_SENTINEL";
    const providerInput = buildTransferredThreadProviderInput({
      historyMessages: [
        message({ id: "old", role: "user", text: `OLD_${"x".repeat(80)}`, seconds: 1 }),
        message({ id: "recent", role: "assistant", text: "RECENT_CONTEXT", seconds: 2 }),
      ],
      currentRequest,
      maxHistoryChars: 90,
    });

    expect(providerInput).toContain("RECENT_CONTEXT");
    expect(providerInput).toContain("older historical message");
    expect(providerInput).not.toContain(`OLD_${"x".repeat(80)}`);
    expect(providerInput.match(new RegExp(currentRequest, "g"))).toHaveLength(1);
  });

  it("selects the last appended marker when consecutive transfers share a timestamp", () => {
    const firstHistory = message({
      id: "first-history",
      role: "user",
      text: "first machine",
      seconds: 1,
    });
    const secondHistory = message({
      id: "second-history",
      role: "assistant",
      text: "second machine",
      seconds: 2,
    });
    const current = message({
      id: "third-machine-request",
      role: "user",
      text: "continue again",
      seconds: 4,
    });
    const markerCreatedAt = timestamp(3);

    expect(
      findPendingTransferredThreadHandoff({
        thread: {
          messages: [firstHistory, secondHistory, current],
          activities: [
            {
              id: EventId.make("z-older-marker"),
              tone: "info",
              kind: "thread.imported",
              summary: "First move",
              payload: {
                exportedAt: timestamp(1),
                providerContextHandoff: {
                  version: 1,
                  required: true,
                  historyMessageCount: 1,
                },
              },
              turnId: null,
              createdAt: markerCreatedAt,
            },
            {
              id: EventId.make("a-newer-marker"),
              tone: "info",
              kind: "thread.imported",
              summary: "Second move",
              payload: {
                exportedAt: timestamp(2),
                providerContextHandoff: {
                  version: 1,
                  required: true,
                  historyMessageCount: 2,
                },
              },
              turnId: null,
              createdAt: markerCreatedAt,
            },
          ],
        },
        currentMessageId: current.id,
        consumedExportedAt: null,
      }),
    ).toMatchObject({
      exportedAt: timestamp(2),
      historyMessages: [firstHistory, secondHistory],
    });
  });
});
