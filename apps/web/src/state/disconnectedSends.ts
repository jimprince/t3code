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
  /**
   * A copy of each environment's held messages, oldest first, replaced on every change so the
   * composer strip re-renders. A counter read inside a memo is not enough: React Compiler drops
   * a dependency the memo body does not use.
   */
  readonly held: Readonly<Partial<Record<EnvironmentId, ReadonlyArray<DisconnectedSend>>>>;
  /** Counts the reasons to deliver now: a new held send or a user Retry. */
  readonly flushRequests: number;
  /** Environments whose last delivery was refused; they stay held until a Retry. */
  readonly refused: ReadonlySet<EnvironmentId>;
}>(() => ({ held: {}, flushRequests: 0, refused: new Set() }));

const NO_HELD_SENDS: ReadonlyArray<DisconnectedSend> = [];

const heldIn = (
  held: Readonly<Partial<Record<EnvironmentId, ReadonlyArray<DisconnectedSend>>>>,
  environmentId: EnvironmentId,
) => ({ ...held, [environmentId]: queueFor(environmentId).pending() });

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
  useQueueStore.setState(({ held, flushRequests }) => ({
    held: heldIn(held, environmentId),
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
    useQueueStore.setState(({ held }) => ({ held: heldIn(held, environmentId) }));
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

function heldForThread(
  held: ReadonlyArray<DisconnectedSend> | undefined,
  threadId: ThreadId | null,
): ReadonlyArray<DisconnectedSend> {
  return threadId === null || held === undefined
    ? NO_HELD_SENDS
    : held.filter((send) => send.threadId === threadId);
}

/** The messages held for one thread, oldest first. */
export function usePendingDisconnectedSends(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
): ReadonlyArray<DisconnectedSend> {
  const held = useQueueStore((store) => store.held[environmentId]);
  return useMemo(() => heldForThread(held, threadId), [held, threadId]);
}

/** Non-hook reads of the same state, for code outside React and for tests. */
export const disconnectedFlushRequests = () => useQueueStore.getState().flushRequests;
export const pendingDisconnectedSends = (environmentId: EnvironmentId, threadId: ThreadId) =>
  heldForThread(useQueueStore.getState().held[environmentId], threadId);
export const isDisconnectedSendsRefused = (environmentId: EnvironmentId) =>
  useQueueStore.getState().refused.has(environmentId);

/** Test seam: forget every queue and outcome. */
export function resetDisconnectedSendsForTest() {
  queues.clear();
  useQueueStore.setState({ held: {}, flushRequests: 0, refused: new Set() });
}
