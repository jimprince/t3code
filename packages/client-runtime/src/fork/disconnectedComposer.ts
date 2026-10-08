// @effect-diagnostics globalTimers:off -- This imperative client queue owns acknowledgement deadlines outside an Effect runtime.
/**
 * Thrown by a flush `send` when the server answered the command and said no. The command is
 * then terminal: its id is never replayed, and the queue keeps it as refused until the caller
 * replaces or removes it. Any other error is a transport failure and keeps the same id for retry.
 */
export class DisconnectedComposerRefusal extends Error {
  override readonly name = "DisconnectedComposerRefusal";
}

/**
 * One in-memory queue per environment. Reconnect retries retain send intent and IDs.
 *
 * `orderKey` groups commands that must keep their order (a thread's messages); commands in
 * other groups are not held up by a refusal. Without it the whole queue is one group.
 */
export function createDisconnectedComposerQueue<
  T extends { readonly commandId: string },
>(options?: { readonly orderKey?: (command: T) => string }) {
  const orderKey = options?.orderKey ?? (() => "");
  const commands: T[] = [];
  const refusals = new Map<string, string>();
  let draining: Promise<void> | undefined;
  return {
    enqueue(command: T): void {
      const existing = commands.find((entry) => entry.commandId === command.commandId);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(command)) {
          throw new Error("A queued composer command ID was reused with different content.");
        }
        return;
      }
      commands.push(command);
    },
    pending(): readonly T[] {
      return commands.slice();
    },
    /** Why the server refused a queued command, or undefined while it is still deliverable. */
    refusal(commandId: string): string | undefined {
      return refusals.get(commandId);
    },
    /** Drops a command (a discard), refused or not; whatever waited behind it may now go. */
    remove(commandId: string): boolean {
      const index = commands.findIndex((entry) => entry.commandId === commandId);
      if (index < 0) return false;
      commands.splice(index, 1);
      refusals.delete(commandId);
      return true;
    },
    /**
     * Swaps a queued command for another (a resend under a new id) without losing its place, and
     * clears its refusal so it is delivered again.
     */
    replace(commandId: string, next: T): void {
      const index = commands.findIndex((entry) => entry.commandId === commandId);
      if (index < 0) throw new Error("The queued composer command no longer exists.");
      if (next.commandId !== commandId && commands.some((e) => e.commandId === next.commandId)) {
        throw new Error("A queued composer command ID is already in use.");
      }
      commands[index] = next;
      refusals.delete(commandId);
    },
    /**
     * Sends in order. A `DisconnectedComposerRefusal` marks that command refused and the drain
     * carries on, except that later commands of the same group wait behind it; any other error
     * stops the drain and leaves everything queued for a retry with the same ids.
     */
    flush(send: (command: T) => Promise<unknown>): Promise<void> {
      if (draining !== undefined) return draining;
      draining = Promise.resolve()
        .then(async () => {
          const blocked = new Set<string>();
          for (const refused of commands) {
            if (refusals.has(refused.commandId)) blocked.add(orderKey(refused));
          }
          for (;;) {
            const next = commands.find(
              (entry) => !refusals.has(entry.commandId) && !blocked.has(orderKey(entry)),
            );
            if (next === undefined) return;
            try {
              await send(next);
            } catch (error) {
              if (!(error instanceof DisconnectedComposerRefusal)) throw error;
              // A command removed or replaced while it was in flight has nothing left to refuse.
              if (commands.includes(next)) refusals.set(next.commandId, error.message);
              blocked.add(orderKey(next));
              continue;
            }
            const index = commands.indexOf(next);
            if (index >= 0) commands.splice(index, 1);
          }
        })
        .finally(() => {
          draining = undefined;
        });
      return draining;
    },
  };
}
