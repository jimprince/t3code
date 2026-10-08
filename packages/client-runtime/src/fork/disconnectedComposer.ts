/** One in-memory queue per environment. Reconnect retries retain send intent and IDs. */
export function createDisconnectedComposerQueue<T extends { readonly commandId: string }>() {
  const commands: T[] = [];
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
    flush(send: (command: T) => Promise<unknown>): Promise<void> {
      if (draining !== undefined) return draining;
      draining = Promise.resolve()
        .then(async () => {
          while (commands[0] !== undefined) {
            await send(commands[0]);
            commands.shift();
          }
        })
        .finally(() => {
          draining = undefined;
        });
      return draining;
    },
  };
}
