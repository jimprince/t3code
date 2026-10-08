/** What a composer submission carries, as far as holding it for a server that is down is concerned. */
export type DisconnectedSendContent = {
  readonly isExistingServerThread: boolean;
  readonly isFirstMessage: boolean;
  readonly text: string;
  readonly attachmentCount: number;
  readonly contextCount: number;
  readonly multipleModels: boolean;
  readonly answeringPrompt: boolean;
  readonly editingQueuedMessage: boolean;
};

/**
 * Whether a send can wait for the server: a plain text message on an existing thread. Anything
 * that needs the server to prepare it (uploads, a new thread or worktree, contexts, commands)
 * is not held, and the composer says so instead of silently keeping it.
 */
export function canHoldSendWhileDisconnected(content: DisconnectedSendContent): boolean {
  const trimmed = content.text.trim();
  return (
    content.isExistingServerThread &&
    !content.isFirstMessage &&
    trimmed.length > 0 &&
    !trimmed.startsWith("/") &&
    content.attachmentCount === 0 &&
    content.contextCount === 0 &&
    !content.multipleModels &&
    !content.answeringPrompt &&
    !content.editingQueuedMessage
  );
}

/**
 * Steering or restarting targets a run the restart is about to end, so a held message waits in
 * the queue instead; the rest keep the mode the composer chose.
 */
export function disconnectedDispatchMode<Mode extends string>(
  mode: Mode,
): Exclude<Mode, "steer" | "restart"> | "queue" {
  return (mode === "steer" || mode === "restart" ? "queue" : mode) as
    | Exclude<Mode, "steer" | "restart">
    | "queue";
}
