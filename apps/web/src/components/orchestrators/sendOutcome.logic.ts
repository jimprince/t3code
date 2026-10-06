import type { MessageId, ThreadId } from "@t3tools/contracts";

/** How a background send ended: it either reached the server or says why not. */
export type SendOutcome = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export interface SendHandle {
  readonly messageId: MessageId;
  readonly queued: boolean;
  readonly done: Promise<SendOutcome>;
}

/** The one-line reason shown after a failed send, from whatever was thrown or squashed. */
export function failureReason(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? (error as { readonly message: unknown }).message
        : error;
  const text = typeof message === "string" ? message.trim() : "";
  return text.length > 0 ? text : "the message could not be sent";
}

export type RequestSendResult =
  | {
      readonly ok: true;
      readonly messageId: MessageId;
      readonly queued: boolean;
      /** Triaged by an intake thread rather than sent to the orchestrator. */
      readonly intake: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Starts the intake thread and sends the request to it, or sends it to the
 * orchestrator when the server has no intake threads. A failed send archives the
 * intake thread it started, so nothing is left behind, and reports why.
 */
export async function sendRequest<Intake extends { readonly threadId: ThreadId }>(deps: {
  readonly startIntake: () => Promise<
    { readonly _tag: "Success"; readonly value: Intake } | { readonly _tag: "Failure" }
  >;
  readonly sendToIntake: (intake: Intake) => SendHandle;
  readonly sendToOrchestrator: () => SendHandle;
  readonly archiveIntake: (threadId: ThreadId) => Promise<unknown>;
}): Promise<RequestSendResult> {
  const intake = await deps.startIntake();
  const handle =
    intake._tag === "Success" ? deps.sendToIntake(intake.value) : deps.sendToOrchestrator();
  const outcome = await handle.done;
  if (outcome.ok) {
    return {
      ok: true,
      messageId: handle.messageId,
      queued: handle.queued,
      intake: intake._tag === "Success",
    };
  }
  if (intake._tag === "Success") {
    await deps.archiveIntake(intake.value.threadId).catch(() => undefined);
  }
  return { ok: false, reason: outcome.reason };
}
