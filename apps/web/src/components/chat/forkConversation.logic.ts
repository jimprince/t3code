import type {
  ContextMenuItem,
  MessageId,
  OrchestrationV2ThreadForkSourcePoint,
} from "@t3tools/contracts";

import type { ChatAttachment, ChatMessage } from "../../types";

export type MessageForkAnchor = "here" | "latest";
export type MessageForkWorkspaceMode = "current" | "new-worktree";

export interface MessageForkPlan {
  readonly sourcePoint: OrchestrationV2ThreadForkSourcePoint;
  readonly anchor: MessageForkAnchor;
  /** Forking before a user message returns its text and images to the new thread's composer. */
  readonly prefill: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  } | null;
}

/**
 * Maps a clicked message to a V2 fork source point. Native threads cut at run
 * boundaries: an assistant message keeps its whole run, a user message keeps
 * everything before its run and hands the message back as a draft. Messages
 * without a run (imported V1 transcripts) can only fork from the latest stable
 * state. Returns null when no cut exists, e.g. the first user message.
 */
export function resolveMessageForkPlan(
  messages: ReadonlyArray<ChatMessage>,
  messageId: MessageId,
): MessageForkPlan | null {
  const index = messages.findIndex((message) => message.id === messageId);
  const selected = messages[index];
  if (selected === undefined || selected.streaming) return null;
  if (selected.runId === null) {
    return { sourcePoint: { type: "latest_stable" }, anchor: "latest", prefill: null };
  }
  if (selected.role !== "user") {
    return {
      sourcePoint: { type: "run", runId: selected.runId },
      anchor: "here",
      prefill: null,
    };
  }
  for (let i = index - 1; i >= 0; i -= 1) {
    const runId = messages[i]!.runId;
    if (runId !== null && runId !== selected.runId) {
      return {
        sourcePoint: { type: "run", runId },
        anchor: "here",
        prefill: { text: selected.text, attachments: selected.attachments ?? [] },
      };
    }
  }
  return null;
}

type MessageForkContextMenuAction = "fork" | "fork-current" | "fork-new-worktree";

export function buildMessageForkContextMenuItems(input: {
  readonly disabled: boolean;
  readonly canForkToNewWorktree: boolean;
  readonly anchor?: MessageForkAnchor;
}): ReadonlyArray<ContextMenuItem<MessageForkContextMenuAction>> {
  const fromHere = (input.anchor ?? "here") === "here";
  return [
    {
      id: "fork",
      label: fromHere ? "Fork thread from here" : "Fork thread from latest state",
      disabled: input.disabled,
      children: [
        {
          id: "fork-current",
          label: "Use current worktree",
          disabled: input.disabled,
        },
        {
          id: "fork-new-worktree",
          label: fromHere ? "Create new worktree from here" : "Create new worktree",
          disabled: input.disabled || !input.canForkToNewWorktree,
        },
      ],
    },
  ];
}

export function shouldClaimMessageForkContextMenu(api: unknown | undefined): boolean {
  return api !== undefined;
}
