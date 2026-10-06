import type { RunId } from "@t3tools/contracts";

/** Shared by the queue control's Steer button and empty-composer Enter. */
export async function promoteQueuedRunOnce(input: {
  queuedRunId: RunId;
  targetRunId: RunId | null;
  canPromote: boolean;
  inFlight: { current: boolean };
  busy: (runId: RunId | null) => void;
  promote: (input: { queuedRunId: RunId; targetRunId: RunId }) => Promise<unknown>;
}): Promise<boolean> {
  if (!input.targetRunId || !input.canPromote || input.inFlight.current) return false;
  input.inFlight.current = true;
  input.busy(input.queuedRunId);
  try {
    await input.promote({ queuedRunId: input.queuedRunId, targetRunId: input.targetRunId });
    return true;
  } finally {
    input.inFlight.current = false;
    input.busy(null);
  }
}
