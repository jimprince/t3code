import type { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ChatAttachment, ChatMessage } from "../../types";
import {
  buildMessageForkContextMenuItems,
  resolveMessageForkPlan,
  shouldClaimMessageForkContextMenu,
} from "./forkConversation.logic";

const message = (
  id: string,
  role: ChatMessage["role"],
  runId: string | null,
  overrides: Partial<ChatMessage> = {},
): ChatMessage => ({
  id: id as MessageId,
  role,
  text: `${role} ${id}`,
  runId: runId as RunId | null,
  streaming: false,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  ...overrides,
});

const image = {
  type: "image",
  id: "image-1",
  name: "shot.png",
  mimeType: "image/png",
  sizeBytes: 12,
} as ChatAttachment;

describe("resolveMessageForkPlan", () => {
  const messages = [
    message("u1", "user", "run-1"),
    message("a1", "assistant", "run-1"),
    message("u2", "user", "run-2", { attachments: [image] }),
    message("a2", "assistant", "run-2"),
  ];

  it("keeps the whole run when forking from an assistant message", () => {
    expect(resolveMessageForkPlan(messages, "a1" as MessageId)).toEqual({
      sourcePoint: { type: "run", runId: "run-1" },
      anchor: "here",
      prefill: null,
    });
  });

  it("forks before a user message and returns its text and attachments", () => {
    expect(resolveMessageForkPlan(messages, "u2" as MessageId)).toEqual({
      sourcePoint: { type: "run", runId: "run-1" },
      anchor: "here",
      prefill: { text: "user u2", attachments: [image] },
    });
  });

  it("offers no cut before the first user message", () => {
    expect(resolveMessageForkPlan(messages, "u1" as MessageId)).toBeNull();
  });

  it("uses the latest stable state for messages without a run", () => {
    const imported = [message("u1", "user", null), message("a1", "assistant", null)];
    for (const id of ["u1", "a1"]) {
      expect(resolveMessageForkPlan(imported, id as MessageId)).toEqual({
        sourcePoint: { type: "latest_stable" },
        anchor: "latest",
        prefill: null,
      });
    }
  });

  it("refuses streaming and unknown messages", () => {
    const streaming = [message("a1", "assistant", "run-1", { streaming: true })];
    expect(resolveMessageForkPlan(streaming, "a1" as MessageId)).toBeNull();
    expect(resolveMessageForkPlan(streaming, "missing" as MessageId)).toBeNull();
  });
});

describe("buildMessageForkContextMenuItems", () => {
  it("offers both workspace modes from here", () => {
    const [item] = buildMessageForkContextMenuItems({
      disabled: false,
      canForkToNewWorktree: true,
    });
    expect(item?.label).toBe("Fork thread from here");
    expect(item?.children?.map((child) => [child.id, child.label, child.disabled])).toEqual([
      ["fork-current", "Use current worktree", false],
      ["fork-new-worktree", "Create new worktree from here", false],
    ]);
  });

  it("disables the new worktree choice outside a git repository", () => {
    const [item] = buildMessageForkContextMenuItems({
      disabled: false,
      canForkToNewWorktree: false,
    });
    expect(item?.disabled).toBe(false);
    expect(item?.children?.find((child) => child.id === "fork-new-worktree")?.disabled).toBe(true);
  });

  it("disables everything while the thread is busy", () => {
    const [item] = buildMessageForkContextMenuItems({
      disabled: true,
      canForkToNewWorktree: true,
    });
    expect(item?.disabled).toBe(true);
    expect(item?.children?.every((child) => child.disabled === true)).toBe(true);
  });

  it("names the latest state honestly for imported transcripts", () => {
    const [item] = buildMessageForkContextMenuItems({
      disabled: false,
      canForkToNewWorktree: true,
      anchor: "latest",
    });
    expect(item?.label).toBe("Fork thread from latest state");
    expect(item?.children?.[1]?.label).toBe("Create new worktree");
  });
});

describe("shouldClaimMessageForkContextMenu", () => {
  it("only claims the menu when a local api exists", () => {
    expect(shouldClaimMessageForkContextMenu(undefined)).toBe(false);
    expect(shouldClaimMessageForkContextMenu({})).toBe(true);
  });
});
