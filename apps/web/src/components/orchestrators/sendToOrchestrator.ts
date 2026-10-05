import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageId, ScopedThreadRef } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { sendQueuedMessage } from "../chat/sendQueuedMessage";

interface ThreadSendSettings {
  readonly modelSelection: OrchestratorSummary["root"]["modelSelection"];
  readonly runtimeMode: OrchestratorSummary["root"]["runtimeMode"];
  readonly interactionMode: OrchestratorSummary["root"]["interactionMode"];
}

/**
 * Sends text (and images) to a thread through the normal queued composer path,
 * so the request ledger captures it like any message Brad types. `busy` queues
 * it behind the thread's running turn instead of sending now.
 */
export function sendToThread(
  threadRef: ScopedThreadRef,
  settings: ThreadSendSettings,
  prompt: string,
  images: ComposerImageAttachment[],
  options: {
    readonly busy?: boolean;
    /** Runs with the message id before it is dispatched, such as marking it a request. */
    readonly beforeSend?: (messageId: MessageId) => Promise<unknown>;
  } = {},
): { readonly messageId: MessageId; readonly queued: boolean } {
  const message = useQueuedMessageStore.getState().enqueue(scopedThreadKey(threadRef), {
    prompt,
    images,
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection: settings.modelSelection,
      runtimeMode: settings.runtimeMode,
      interactionMode: settings.interactionMode,
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: new Date().toISOString(),
  });
  const busy = options.busy === true;
  void (async () => {
    await options.beforeSend?.(message.messageId);
    if (!busy) await sendQueuedMessage(threadRef, message.id);
  })();
  return { messageId: message.messageId, queued: busy };
}

/** Sends text (and images) verbatim to the project's orchestrator. */
export function sendToOrchestrator(
  summary: OrchestratorSummary,
  prompt: string,
  images: ComposerImageAttachment[] = [],
  /** Runs with the message id before it is dispatched, such as marking it a request. */
  beforeSend?: (messageId: MessageId) => Promise<unknown>,
): { readonly messageId: MessageId; readonly queued: boolean } {
  return sendToThread(
    scopeThreadRef(summary.root.environmentId, summary.root.id),
    summary.root,
    prompt,
    images,
    {
      busy:
        summary.root.session?.status === "running" || summary.root.session?.status === "starting",
      ...(beforeSend ? { beforeSend } : {}),
    },
  );
}
