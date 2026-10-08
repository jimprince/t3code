import { createDisconnectedComposerQueue } from "@t3tools/client-runtime/fork/disconnected-composer";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import type { CommandId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { create } from "zustand";

/** A send the composer built while its server was down, with the command id it will keep. */
export type DisconnectedSend = StartThreadTurnInput & { readonly commandId: CommandId };

type SendQueue = ReturnType<typeof createDisconnectedComposerQueue<DisconnectedSend>>;

// One in-memory queue per environment, alive across transport loss; a reload drops it.
const queues = new Map<EnvironmentId, SendQueue>();

const useQueueStore = create<{
  /** Changes whenever the queue contents or a delivery outcome changes; drives the banner. */
  readonly revision: number;
  /** Counts the reasons to deliver now: a new held send or a user Retry. */
  readonly flushRequests: number;
  /** Environments whose last delivery was refused; they stay held until a Retry. */
  readonly refused: ReadonlySet<EnvironmentId>;
}>(() => ({ revision: 0, flushRequests: 0, refused: new Set() }));

const bump = () => useQueueStore.setState(({ revision }) => ({ revision: revision + 1 }));

function setRefused(environmentId: EnvironmentId, refused: boolean) {
  useQueueStore.setState((store) => {
    if (store.refused.has(environmentId) === refused) return store;
    const next = new Set(store.refused);
    if (refused) next.add(environmentId);
    else next.delete(environmentId);
    return { refused: next };
  });
}

function queueFor(environmentId: EnvironmentId): SendQueue {
  let queue = queues.get(environmentId);
  if (!queue) {
    queue = createDisconnectedComposerQueue<DisconnectedSend>();
    queues.set(environmentId, queue);
  }
  return queue;
}

export function enqueueDisconnectedSend(environmentId: EnvironmentId, send: DisconnectedSend) {
  queueFor(environmentId).enqueue(send);
  useQueueStore.setState(({ revision, flushRequests }) => ({
    revision: revision + 1,
    flushRequests: flushRequests + 1,
  }));
}

const hasDisconnectedSends = (environmentId: EnvironmentId) =>
  (queues.get(environmentId)?.pending().length ?? 0) > 0;

/** Sends them first in, first out; whatever the server does not acknowledge stays held. */
async function flushDisconnectedSends(
  environmentId: EnvironmentId,
  send: (command: DisconnectedSend) => Promise<unknown>,
): Promise<void> {
  setRefused(environmentId, false);
  try {
    await queueFor(environmentId).flush(send);
  } catch (error) {
    setRefused(environmentId, true);
    throw error;
  } finally {
    bump();
  }
}

/**
 * Delivers what every given (connected) environment holds. A refusal keeps the held messages,
 * marks the environment as refused and does not retry on its own; that is left to Retry.
 */
export function flushHeldSends(
  environmentIds: ReadonlyArray<EnvironmentId>,
  send: (environmentId: EnvironmentId, command: DisconnectedSend) => Promise<unknown>,
): Promise<unknown> {
  return Promise.all(
    environmentIds
      .filter(hasDisconnectedSends)
      .map((environmentId) =>
        flushDisconnectedSends(environmentId, (command) => send(environmentId, command)).catch(
          () => undefined,
        ),
      ),
  );
}

/** The user asked to deliver the held messages again; the same commands are replayed. */
export function retryDisconnectedSends(environmentId: EnvironmentId) {
  setRefused(environmentId, false);
  useQueueStore.setState(({ flushRequests }) => ({ flushRequests: flushRequests + 1 }));
}

/** Changes when held messages should be delivered now (a new one, or a Retry). */
export const useDisconnectedFlushRequests = () => useQueueStore((store) => store.flushRequests);

/** Whether the server refused the held messages of this environment and is waiting for Retry. */
export const useDisconnectedSendsRefused = (environmentId: EnvironmentId) =>
  useQueueStore((store) => store.refused.has(environmentId));

/** The messages held for one thread, oldest first. */
export function usePendingDisconnectedSends(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<DisconnectedSend> {
  const revision = useQueueStore((store) => store.revision);
  return useMemo(() => {
    void revision;
    return threadId === null
      ? []
      : (queues.get(environmentId)?.pending() ?? []).filter((send) => send.threadId === threadId);
  }, [environmentId, revision, threadId]);
}

/** Non-hook reads of the same state, for code outside React and for tests. */
export const disconnectedFlushRequests = () => useQueueStore.getState().flushRequests;
export const isDisconnectedSendsRefused = (environmentId: EnvironmentId) =>
  useQueueStore.getState().refused.has(environmentId);

/** Test seam: forget every queue and outcome. */
export function resetDisconnectedSendsForTest() {
  queues.clear();
  useQueueStore.setState({ revision: 0, flushRequests: 0, refused: new Set() });
}
