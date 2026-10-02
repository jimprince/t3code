import { describe, expect, it } from "vite-plus/test";
import { MessageId, ScheduledTaskId, ThreadId } from "@t3tools/contracts";
import { isHumanAuthoredMessage } from "./humanOrigin.ts";

const base = {
  role: "user" as const,
  createdBy: "user" as const,
  creationSource: "web" as const,
};

describe("human-authored message classification", () => {
  it("accepts direct web/mobile and explicit human-origin messages", () => {
    expect(isHumanAuthoredMessage(base)).toBe(true);
    expect(isHumanAuthoredMessage({ ...base, creationSource: "mobile" })).toBe(true);
    expect(
      isHumanAuthoredMessage({
        ...base,
        createdBy: "agent",
        creationSource: "mcp",
        humanOrigin: { principal: "brad", sourceMessageId: MessageId.make("message") },
      }),
    ).toBe(true);
  });

  it("excludes scheduled, inter-thread, and assistant messages", () => {
    expect(
      isHumanAuthoredMessage({ ...base, scheduledTaskId: ScheduledTaskId.make("schedule") }),
    ).toBe(false);
    expect(isHumanAuthoredMessage({ ...base, senderThreadId: ThreadId.make("thread") })).toBe(
      false,
    );
    expect(isHumanAuthoredMessage({ ...base, role: "assistant" })).toBe(false);
    expect(isHumanAuthoredMessage({ ...base, createdBy: "agent", creationSource: "mcp" })).toBe(
      false,
    );
  });
});
