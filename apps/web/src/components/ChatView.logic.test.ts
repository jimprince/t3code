import { ApprovalRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  buildExpiredTerminalContextToastCopy,
  buildNextProviderModelSelection,
  canAdvancePendingUserInput,
  deriveComposerSendState,
  derivePendingComposerPromptState,
  derivePendingPromptOwnershipTransition,
  isComposerPromptDisabled,
  reconcileMountedTerminalThreadIds,
  reconcileRespondingUserInputRequestIds,
  resolveProviderForModelPickerChange,
  shouldRenderTextGenerationTraitsControl,
} from "./ChatView.logic";

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: "2026-03-17T12:52:29.000Z",
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("reconcileMountedTerminalThreadIds", () => {
  it("keeps the active thread mounted and trims hidden history", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_TERMINAL_THREADS + 2 },
      (_, index) => ThreadId.makeUnsafe(`thread-${index + 1}`),
    );

    expect(
      reconcileMountedTerminalThreadIds({
        currentThreadIds,
        openThreadIds: [...currentThreadIds, ThreadId.makeUnsafe("thread-active")],
        activeThreadId: ThreadId.makeUnsafe("thread-active"),
        activeThreadTerminalOpen: true,
      }).at(-1),
    ).toBe(ThreadId.makeUnsafe("thread-active"));
  });
});

describe("canAdvancePendingUserInput", () => {
  it("blocks advancement while a response is in flight", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: true,
        canAdvance: true,
        isLastQuestion: false,
        hasResolvedAnswers: false,
      }),
    ).toBe(false);
  });

  it("requires resolved answers on the last question", () => {
    expect(
      canAdvancePendingUserInput({
        hasProgress: true,
        isResponding: false,
        canAdvance: true,
        isLastQuestion: true,
        hasResolvedAnswers: false,
      }),
    ).toBe(false);
  });
});

describe("reconcileRespondingUserInputRequestIds", () => {
  it("drops missing or failed request ids", () => {
    expect(
      reconcileRespondingUserInputRequestIds(
        [ApprovalRequestId.makeUnsafe("request-1"), ApprovalRequestId.makeUnsafe("request-2")],
        [{ requestId: ApprovalRequestId.makeUnsafe("request-1") }],
        [ApprovalRequestId.makeUnsafe("request-1")],
      ),
    ).toEqual([]);
  });
});

describe("derivePendingComposerPromptState", () => {
  it("syncs the active pending custom answer into the prompt", () => {
    expect(
      derivePendingComposerPromptState({
        draftPrompt: "stale draft",
        promptRefValue: "stale ref",
        pendingPromptOwnership: "active",
        activePendingCustomAnswer: "fresh pending answer",
      }),
    ).toEqual({
      nextPrompt: "fresh pending answer",
      shouldSyncDraftPrompt: true,
      shouldSyncPromptRef: true,
    });
  });
});

describe("derivePendingPromptOwnershipTransition", () => {
  it("marks prior pending-input state as released until cleanup runs", () => {
    expect(
      derivePendingPromptOwnershipTransition({
        hasActivePendingProgress: false,
        lastSyncedPendingInput: {
          requestId: "req-1",
          questionId: "question-1",
        },
      }),
    ).toEqual({
      ownership: "released",
      nextLastSyncedPendingInput: null,
    });
  });
});

describe("isComposerPromptDisabled", () => {
  it("keeps pending user-input responses disabled", () => {
    expect(
      isComposerPromptDisabled({
        isConnecting: false,
        isComposerApprovalState: false,
        activePendingIsResponding: true,
      }),
    ).toBe(true);
  });
});

describe("buildNextProviderModelSelection", () => {
  it("preserves same-provider options", () => {
    expect(
      buildNextProviderModelSelection({
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        existingSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: { effort: "max" },
        },
      }),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-sonnet-4-6",
      options: { effort: "max" },
    });
  });
});

describe("resolveProviderForModelPickerChange", () => {
  it("prefers the locked provider when present", () => {
    expect(
      resolveProviderForModelPickerChange({
        requestedProvider: "claudeAgent",
        lockedProvider: "claudeAgent",
        selectableProvider: "codex",
      }),
    ).toBe("claudeAgent");
  });
});

describe("shouldRenderTextGenerationTraitsControl", () => {
  it("hides traits for opencode", () => {
    expect(shouldRenderTextGenerationTraitsControl("opencode")).toBe(false);
  });
});
