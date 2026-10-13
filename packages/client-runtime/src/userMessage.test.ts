import { ScheduledTaskId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveUserMessagePresentation, splitAgentMessageHeader } from "./userMessage.ts";

describe("resolveUserMessagePresentation", () => {
  const legacyText = "[Triggered by schedule task: Daily audit]\n\nCheck for crashes.\n";

  it("removes attribution from legacy scheduled prompts", () => {
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text: legacyText }),
    ).toEqual({ text: "Check for crashes.\n", isAutomation: true, scheduledTaskId: undefined });
  });

  it("uses task metadata without changing the prompt", () => {
    expect(
      resolveUserMessagePresentation({
        role: "user",
        createdBy: "agent",
        scheduledTaskId: ScheduledTaskId.make("task-1"),
        text: legacyText,
      }),
    ).toEqual({ text: legacyText, isAutomation: true, scheduledTaskId: "task-1" });
  });

  it("preserves user-written and assistant-quoted schedule headers", () => {
    for (const message of [
      { role: "user", createdBy: "user" as const },
      { role: "user" },
      { role: "assistant", createdBy: "agent" as const },
    ]) {
      expect(resolveUserMessagePresentation({ ...message, text: legacyText })).toEqual({
        text: legacyText,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("leaves other agent prompts and embedded headers intact", () => {
    for (const text of [
      "Review this area",
      `Quoted prompt:\n${legacyText}`,
      "[Triggered by schedule task: Daily audit]",
    ]) {
      expect(resolveUserMessagePresentation({ role: "user", createdBy: "agent", text })).toEqual({
        text,
        isAutomation: false,
        scheduledTaskId: undefined,
      });
    }
  });

  it("recovers the triggering automation from older scheduler message ids", () => {
    for (const trigger of ["scheduled", "manual"]) {
      expect(
        resolveUserMessagePresentation({
          id: `scheduled-task-message:task:daily-audit:1788661140000:${trigger}`,
          role: "user",
          createdBy: "user",
          text: legacyText,
        }),
      ).toEqual({
        text: "Check for crashes.\n",
        isAutomation: true,
        scheduledTaskId: "task:daily-audit",
      });
    }
  });
});

describe("splitAgentMessageHeader", () => {
  const named =
    'T3 thread message: thread_id: "0f1e6485-6665"; saved_name: "gpu-transcriber-hotwords"; environment: "local-mbp"; reply: "t3-thread send gpu-transcriber-hotwords ..."';
  const unnamed =
    'T3 thread message: thread_id: "0f1e6485-6665"; saved_name: null; environment: "dev-vm"; reply: "t3-thread send 0f1e6485-6665 ..."';

  it("splits a named header from the body", () => {
    expect(splitAgentMessageHeader(`${named}\nConsolidated ask.\n`)).toEqual({
      header: {
        text: named.slice("T3 thread message: ".length),
        savedName: "gpu-transcriber-hotwords",
        environment: "local-mbp",
      },
      text: "Consolidated ask.\n",
    });
  });

  it("reads an unnamed sender as no saved name", () => {
    const { header, text } = splitAgentMessageHeader(`${unnamed}\nHello`);
    expect(header).toMatchObject({ savedName: null, environment: "dev-vm" });
    expect(text).toBe("Hello");
  });

  it("returns messages without a header unchanged", () => {
    for (const text of ["Review this area", `Quoted:\n${named}`]) {
      expect(splitAgentMessageHeader(text)).toEqual({ header: undefined, text });
    }
  });

  it("only strips the header from agent-created messages", () => {
    const text = `${named}\nBody`;
    expect(
      resolveUserMessagePresentation({ role: "user", createdBy: "agent", text }),
    ).toMatchObject({ text: "Body", agentHeader: { savedName: "gpu-transcriber-hotwords" } });
    expect(resolveUserMessagePresentation({ role: "user", createdBy: "user", text })).toMatchObject(
      { text, agentHeader: undefined },
    );
  });
});
