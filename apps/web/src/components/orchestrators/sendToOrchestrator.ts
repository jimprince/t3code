import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { MessageId } from "@t3tools/contracts";
import { useCallback } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { newMessageId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readFileAsDataUrl } from "../ChatView.logic";

/**
 * Sends text (and images) verbatim to the project's orchestrator through the
 * normal message dispatch, so the request ledger captures it like any message
 * Brad types. The server queues it behind the turn when the orchestrator is busy.
 */
export function useSendToOrchestrator() {
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  return useCallback(
    (
      summary: OrchestratorSummary,
      prompt: string,
      images: ComposerImageAttachment[] = [],
    ): { readonly messageId: MessageId; readonly queued: boolean } => {
      const messageId = newMessageId();
      const queued = threadRuntimeIsActive(summary.root.runtime);
      void (async () => {
        const attachments = await Promise.all(
          images.map(async (image) => ({
            type: "image" as const,
            id: image.id,
            name: image.name,
            mimeType: image.mimeType,
            sizeBytes: image.sizeBytes,
            dataUrl: await readFileAsDataUrl(image.file),
            ...(image.source ? { source: image.source } : {}),
          })),
        );
        await startTurn({
          environmentId: summary.root.environmentId,
          input: {
            threadId: summary.root.id,
            message: { messageId, role: "user", text: prompt, attachments },
            modelSelection: summary.root.modelSelection,
            runtimeMode: summary.root.runtimeMode,
            interactionMode: summary.root.interactionMode,
            dispatchMode: queued ? "queue" : "auto",
            createdAt: new Date().toISOString(),
          },
        });
      })();
      return { messageId, queued };
    },
    [startTurn],
  );
}
