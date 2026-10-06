import type { QueuedRunsControlHandle } from "./components/chat/QueuedRunsControl";

/** Empty composer submission uses the same native promotion and guards as Steer. */
export function sendQueuedRunOnEmptyEnter(
  input: { hasSendableContent: boolean; expiredTerminalContextCount: number; repeat?: boolean },
  control: Pick<QueuedRunsControlHandle, "steerNext"> | null,
): boolean {
  if (input.hasSendableContent || input.expiredTerminalContextCount > 0) return false;
  return control?.steerNext(input.repeat === true) ?? false;
}
