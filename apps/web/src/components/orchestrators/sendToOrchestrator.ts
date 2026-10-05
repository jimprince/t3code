import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageId } from "@t3tools/contracts";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { sendQueuedMessage } from "../chat/sendQueuedMessage";

/**
 * Sends text (and images) verbatim to the project's orchestrator through the
 * normal queued composer path, so the request ledger captures it like any
 * message Brad types. Queued behind the turn when the orchestrator is busy.
 */
export function sendToOrchestrator(
  summary: OrchestratorSummary,
  prompt: string,
  images: ComposerImageAttachment[] = [],
  /** Runs with the message id before it is dispatched, such as marking it a request. */
  beforeSend?: (messageId: MessageId) => Promise<unknown>,
): { readonly messageId: MessageId; readonly queued: boolean } {
  const rootRef = scopeThreadRef(summary.root.environmentId, summary.root.id);
  const message = useQueuedMessageStore.getState().enqueue(scopedThreadKey(rootRef), {
    prompt,
    images,
    files: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    sendSettings: {
      modelSelection: summary.root.modelSelection,
      runtimeMode: summary.root.runtimeMode,
      interactionMode: summary.root.interactionMode,
      promptEffort: null,
    },
    queuedAfterToolActivityId: null,
    createdAt: new Date().toISOString(),
  });
  const running =
    summary.root.session?.status === "running" || summary.root.session?.status === "starting";
  void (async () => {
    await beforeSend?.(message.messageId);
    if (!running) await sendQueuedMessage(rootRef, message.id);
  })();
  return { messageId: message.messageId, queued: running };
}
