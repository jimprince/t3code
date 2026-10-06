import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { OrchestratorSummary } from "@t3tools/client-runtime/state/orchestrators";
import type { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useCallback } from "react";

import type { ComposerImageAttachment } from "../../composerDraftStore";
import { newMessageId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { readFileAsDataUrl } from "../ChatView.logic";
import { failureReason, type SendHandle, type SendOutcome } from "./sendOutcome.logic";

interface ThreadSendSettings {
  readonly modelSelection: OrchestratorSummary["root"]["modelSelection"];
  readonly runtimeMode: OrchestratorSummary["root"]["runtimeMode"];
  readonly interactionMode: OrchestratorSummary["root"]["interactionMode"];
}

/**
 * Sends text (and images) to a thread through the normal message dispatch, so
 * the request ledger captures it like any message Brad types. `busy` queues it
 * behind the thread's running turn instead of sending now. `done` settles once
 * the server has taken the message or says why it did not; it never rejects.
 */
export function useSendToThread() {
  const startTurn = useAtomCommand(threadEnvironment.startTurn);
  return useCallback(
    (
      target: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
      settings: ThreadSendSettings,
      prompt: string,
      images: ComposerImageAttachment[],
      options: {
        readonly busy?: boolean;
        /** Runs with the message id before it is dispatched, such as marking it a request. */
        readonly beforeSend?: (messageId: MessageId) => Promise<unknown>;
      } = {},
    ): SendHandle => {
      const messageId = newMessageId();
      const queued = options.busy === true;
      const done = (async (): Promise<SendOutcome> => {
        try {
          await options.beforeSend?.(messageId);
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
          const result = await startTurn({
            environmentId: target.environmentId,
            input: {
              threadId: target.threadId,
              message: { messageId, role: "user", text: prompt, attachments },
              modelSelection: settings.modelSelection,
              runtimeMode: settings.runtimeMode,
              interactionMode: settings.interactionMode,
              dispatchMode: queued ? "queue" : "auto",
              createdAt: new Date().toISOString(),
            },
          });
          return result._tag === "Success"
            ? { ok: true }
            : { ok: false, reason: failureReason(squashAtomCommandFailure(result)) };
        } catch (error) {
          return { ok: false, reason: failureReason(error) };
        }
      })();
      return { messageId, queued, done };
    },
    [startTurn],
  );
}

/**
 * Sends text (and images) verbatim to the project's orchestrator through the
 * normal message dispatch, so the request ledger captures it like any message
 * Brad types. The server queues it behind the turn when the orchestrator is busy.
 */
export function useSendToOrchestrator() {
  const sendToThread = useSendToThread();
  return useCallback(
    (
      summary: OrchestratorSummary,
      prompt: string,
      images: ComposerImageAttachment[] = [],
      /** Runs with the message id before it is dispatched, such as marking it a request. */
      beforeSend?: (messageId: MessageId) => Promise<unknown>,
    ): SendHandle =>
      sendToThread(
        { environmentId: summary.root.environmentId, threadId: summary.root.id },
        summary.root,
        prompt,
        images,
        {
          busy: threadRuntimeIsActive(summary.root.runtime),
          ...(beforeSend ? { beforeSend } : {}),
        },
      ),
    [sendToThread],
  );
}
