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

/** What a failed send leaves behind, so a retry of the same request reuses it instead of filing a second one. */
export interface SendAttempt<Intake extends { readonly threadId: ThreadId }> {
  /** The request as sent (text and image ids); a retry reuses the attempt only while it is unchanged. */
  readonly key: string;
  readonly messageId: MessageId;
  /** The intake thread the request was sent to, or null when it went to the orchestrator. */
  readonly intake: Intake | null;
}

export function attemptKey(text: string, imageIds: ReadonlyArray<string>): string {
  return JSON.stringify([text, imageIds]);
}

export type RequestSendResult<Intake extends { readonly threadId: ThreadId }> =
  | {
      readonly ok: true;
      readonly messageId: MessageId;
      readonly queued: boolean;
      /** Triaged by an intake thread rather than sent to the orchestrator. */
      readonly intake: boolean;
    }
  | { readonly ok: false; readonly reason: string; readonly attempt: SendAttempt<Intake> };

/**
 * Starts the intake thread and sends the request to it, or sends it to the
 * orchestrator when the server has no intake threads. The request is filed (marked
 * explicit under its message id) before the send, so a failed send leaves it filed:
 * the failure returns the attempt, and passing it back as `previous` retries under the
 * same message id and intake thread, which files nothing new. Archiving the intake
 * thread is up to the caller, once the request is abandoned.
 */
export async function sendRequest<Intake extends { readonly threadId: ThreadId }>(deps: {
  readonly key: string;
  readonly previous?: SendAttempt<Intake> | null;
  readonly startIntake: () => Promise<
    { readonly _tag: "Success"; readonly value: Intake } | { readonly _tag: "Failure" }
  >;
  readonly sendToIntake: (intake: Intake, messageId: MessageId | undefined) => SendHandle;
  readonly sendToOrchestrator: (messageId: MessageId | undefined) => SendHandle;
}): Promise<RequestSendResult<Intake>> {
  const { previous } = deps;
  const intake: Intake | null = previous
    ? previous.intake
    : await deps
        .startIntake()
        .then((started) => (started._tag === "Success" ? started.value : null));
  const handle =
    intake === null
      ? deps.sendToOrchestrator(previous?.messageId)
      : deps.sendToIntake(intake, previous?.messageId);
  const outcome = await handle.done;
  if (outcome.ok) {
    return {
      ok: true,
      messageId: handle.messageId,
      queued: handle.queued,
      intake: intake !== null,
    };
  }
  return {
    ok: false,
    reason: outcome.reason,
    attempt: { key: deps.key, messageId: handle.messageId, intake },
  };
}
