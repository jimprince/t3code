import type { QueuedComposerMessage } from "./queuedMessageStore";

/**
 * Picks the queued message that Enter on an empty composer sends now, the same
 * as pressing Send now on its row: Enter once queues, Enter again sends.
 * Returns null when the composer still holds content, including expired
 * terminal contexts, which keep their own warning.
 */
export function queuedMessageForEmptyEnter(input: {
  queue: ReadonlyArray<QueuedComposerMessage>;
  hasSendableContent: boolean;
  expiredTerminalContextCount: number;
}): QueuedComposerMessage | null {
  if (input.hasSendableContent) return null;
  if (input.expiredTerminalContextCount > 0) return null;
  return input.queue[0] ?? null;
}
