import {
  ProjectId,
  ApprovalRequestId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderKind,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { type ChatMessage, type SessionPhase, type Thread, type ThreadSession } from "../types";
import { randomUUID } from "~/lib/utils";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { Schema } from "effect";
import { useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
const WORKTREE_BRANCH_PREFIX = "t3code";

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<ThreadId>;
  openThreadIds: ReadonlyArray<ThreadId>;
  activeThreadId: ThreadId | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): ThreadId[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function buildTemporaryWorktreeBranchName(): string {
  // Keep the 8-hex suffix shape for backend temporary-branch detection.
  const token = randomUUID().slice(0, 8).toLowerCase();
  return `${WORKTREE_BRANCH_PREFIX}/${token}`;
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 || options.imageCount > 0 || sendableTerminalContexts.length > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

export async function waitForStartedServerThread(
  threadId: ThreadId,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => useStore.getState().threads.find((thread) => thread.id === threadId);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(state.threads.find((thread) => thread.id === threadId))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionOrchestrationStatus: ThreadSession["orchestrationStatus"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionOrchestrationStatus: session?.orchestrationStatus ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (
    input.phase === "running" ||
    input.hasPendingApproval ||
    input.hasPendingUserInput ||
    Boolean(input.threadError)
  ) {
    return true;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;

  return (
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null) ||
    input.localDispatch.sessionOrchestrationStatus !== (session?.orchestrationStatus ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}

export function canAdvancePendingUserInput(input: {
  hasProgress: boolean;
  isResponding: boolean;
  canAdvance: boolean;
  isLastQuestion: boolean;
  hasResolvedAnswers: boolean;
}): boolean {
  if (!input.hasProgress || input.isResponding) {
    return false;
  }
  if (input.isLastQuestion) {
    return input.hasResolvedAnswers;
  }
  return input.canAdvance;
}

export function reconcileRespondingUserInputRequestIds(
  respondingRequestIds: ReadonlyArray<ApprovalRequestId>,
  pendingUserInputs: ReadonlyArray<{ requestId: ApprovalRequestId }>,
  failedRequestIds: ReadonlyArray<ApprovalRequestId> = [],
): ApprovalRequestId[] {
  const pendingRequestIds = new Set(pendingUserInputs.map((prompt) => prompt.requestId));
  const failedRequestIdSet = new Set(failedRequestIds);
  return respondingRequestIds.filter(
    (requestId) => pendingRequestIds.has(requestId) && !failedRequestIdSet.has(requestId),
  );
}

export function collectRetryableUserInputRespondFailedRequestIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ApprovalRequestId[] {
  return activities.flatMap((activity) => {
    if (activity.kind !== "provider.user-input.respond.failed") {
      return [];
    }
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId =
      payload && typeof payload.requestId === "string"
        ? ApprovalRequestId.makeUnsafe(payload.requestId)
        : null;
    const detail = payload && typeof payload.detail === "string" ? payload.detail : undefined;
    if (!requestId || detail?.includes("stale pending request")) {
      return [];
    }
    return [requestId];
  });
}

export function derivePendingComposerPromptState(input: {
  draftPrompt: string;
  promptRefValue: string;
  pendingPromptOwnership: "active" | "released" | "inactive";
  activePendingCustomAnswer: string | null;
}): {
  nextPrompt: string;
  shouldSyncDraftPrompt: boolean;
  shouldSyncPromptRef: boolean;
} {
  if (
    input.pendingPromptOwnership === "active" &&
    typeof input.activePendingCustomAnswer === "string"
  ) {
    return {
      nextPrompt: input.activePendingCustomAnswer,
      shouldSyncDraftPrompt: input.draftPrompt !== input.activePendingCustomAnswer,
      shouldSyncPromptRef: input.promptRefValue !== input.activePendingCustomAnswer,
    };
  }
  if (input.pendingPromptOwnership === "inactive") {
    return {
      nextPrompt: input.draftPrompt,
      shouldSyncDraftPrompt: false,
      shouldSyncPromptRef: false,
    };
  }
  return {
    nextPrompt: "",
    shouldSyncDraftPrompt: input.draftPrompt.length > 0,
    shouldSyncPromptRef: input.promptRefValue.length > 0,
  };
}

export function derivePendingPromptOwnershipTransition(input: {
  hasActivePendingProgress: boolean;
  lastSyncedPendingInput: {
    requestId: string | null;
    questionId: string | null;
  } | null;
}): {
  ownership: "active" | "released" | "inactive";
  nextLastSyncedPendingInput: {
    requestId: string | null;
    questionId: string | null;
  } | null;
} {
  if (input.hasActivePendingProgress) {
    return {
      ownership: "active",
      nextLastSyncedPendingInput: input.lastSyncedPendingInput,
    };
  }

  const hasRealPendingMarker = Boolean(
    input.lastSyncedPendingInput?.requestId ?? input.lastSyncedPendingInput?.questionId,
  );
  if (hasRealPendingMarker) {
    return {
      ownership: "released",
      nextLastSyncedPendingInput: null,
    };
  }

  return {
    ownership: "inactive",
    nextLastSyncedPendingInput: null,
  };
}

export function isComposerPromptDisabled(input: {
  isConnecting: boolean;
  isComposerApprovalState: boolean;
  activePendingIsResponding: boolean;
}): boolean {
  return input.isConnecting || input.isComposerApprovalState || input.activePendingIsResponding;
}

export function buildNextProviderModelSelection(input: {
  provider: ProviderKind;
  model: string;
  existingSelection: ModelSelection | null | undefined;
  sameProviderSelection?: ModelSelection | null | undefined;
}): ModelSelection {
  const selectionToPreserve =
    input.sameProviderSelection?.provider === input.provider
      ? input.sameProviderSelection
      : input.existingSelection?.provider === input.provider
        ? input.existingSelection
        : null;
  if (selectionToPreserve?.options) {
    return {
      provider: input.provider,
      model: input.model,
      options: selectionToPreserve.options,
    } as ModelSelection;
  }
  return {
    provider: input.provider,
    model: input.model,
  } as ModelSelection;
}

export function resolveProviderForModelPickerChange(input: {
  requestedProvider: ProviderKind;
  lockedProvider: ProviderKind | null;
  selectableProvider: ProviderKind;
}): ProviderKind {
  return input.lockedProvider ?? input.selectableProvider;
}

export function buildNextTextGenerationModelSelection(input: {
  provider: ProviderKind;
  model: string;
  existingSelection: ModelSelection | null | undefined;
}): ModelSelection {
  if (input.existingSelection?.provider === input.provider && input.existingSelection.options) {
    return {
      provider: input.provider,
      model: input.model,
      options: input.existingSelection.options,
    } as ModelSelection;
  }
  return {
    provider: input.provider,
    model: input.model,
  } as ModelSelection;
}

export function buildProviderModelOptionsWithRememberedSelections(input: {
  baseOptionsByProvider: Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>>;
  rememberedSelectionsByProvider: Partial<Record<ProviderKind, ModelSelection | null | undefined>>;
}): Record<ProviderKind, ReadonlyArray<{ slug: string; name: string }>> {
  const appendRememberedModel = (
    provider: ProviderKind,
    options: ReadonlyArray<{ slug: string; name: string }>,
  ) => {
    const rememberedSelection = input.rememberedSelectionsByProvider[provider];
    if (
      !rememberedSelection?.model ||
      options.some((option) => option.slug === rememberedSelection.model)
    ) {
      return options;
    }
    return [...options, { slug: rememberedSelection.model, name: rememberedSelection.model }];
  };

  return {
    codex: appendRememberedModel("codex", input.baseOptionsByProvider.codex),
    claudeAgent: appendRememberedModel("claudeAgent", input.baseOptionsByProvider.claudeAgent),
    opencode: appendRememberedModel("opencode", input.baseOptionsByProvider.opencode),
  };
}

export function shouldRenderTextGenerationTraitsControl(provider: ProviderKind): boolean {
  return provider !== "opencode";
}
