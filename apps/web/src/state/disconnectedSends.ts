import {
  createDisconnectedComposerQueue,
  DisconnectedComposerRefusal,
} from "@t3tools/client-runtime/fork/disconnected-composer";
import type { StartThreadTurnInput } from "@t3tools/client-runtime/operations";
import { CommandId, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { useMemo } from "react";
import { create } from "zustand";

import { newMessageId, randomUUID } from "../lib/utils";

/** A send the composer built while its server was down, with the command id it will keep. */
export type DisconnectedSend = StartThreadTurnInput & { readonly commandId: CommandId };

type SendQueue = ReturnType<typeof createDisconnectedComposerQueue<DisconnectedSend>>;

// One in-memory queue per environment, alive across transport loss; a reload drops it.
const queues = new Map<EnvironmentId, SendQueue>();

/** Why the server refused each held message, by command id. */
type Refusals = Readonly<Record<string, string>>;

const useQueueStore = create<{
  /**
   * A copy of each environment's held messages, oldest first, replaced on every change so the
   * composer strip re-renders. A counter read inside a memo is not enough: React Compiler drops
   * a dependency the memo body does not use.
   */
  readonly held: Readonly<Partial<Record<EnvironmentId, ReadonlyArray<DisconnectedSend>>>>;
  /** The held messages the server refused; they wait for Resend or Discard, never a replay. */
  readonly refusals: Readonly<Partial<Record<EnvironmentId, Refusals>>>;
  /** Counts the reasons to deliver now: a new held send, a Resend, a Discard or a Retry. */
  readonly flushRequests: number;
  /** Environments whose last delivery failed in transit; they stay held until a Retry. */
  readonly stalled: ReadonlySet<EnvironmentId>;
}>(() => ({ held: {}, refusals: {}, flushRequests: 0, stalled: new Set() }));

const NO_HELD_SENDS: ReadonlyArray<DisconnectedSend> = [];
const NO_REFUSALS: Refusals = {};

/** Publishes an environment's queue to the store so the composer strip sees it. */
function publish(environmentId: EnvironmentId) {
  const queue = queueFor(environmentId);
  const pending = queue.pending();
  const refusals: Record<string, string> = {};
  for (const send of pending) {
    const reason = queue.refusal(send.commandId);
    if (reason !== undefined) refusals[send.commandId] = reason;
  }
  useQueueStore.setState((store) => ({
    held: { ...store.held, [environmentId]: pending },
    refusals: { ...store.refusals, [environmentId]: refusals },
  }));
}

function setStalled(environmentId: EnvironmentId, stalled: boolean) {
  useQueueStore.setState((store) => {
    if (store.stalled.has(environmentId) === stalled) return store;
    const next = new Set(store.stalled);
    if (stalled) next.add(environmentId);
    else next.delete(environmentId);
    return { stalled: next };
  });
}

function queueFor(environmentId: EnvironmentId): SendQueue {
  let queue = queues.get(environmentId);
  if (!queue) {
    // A thread's messages keep their order; a refusal in one thread does not hold up another.
    queue = createDisconnectedComposerQueue<DisconnectedSend>({
      orderKey: (send) => send.threadId,
    });
    queues.set(environmentId, queue);
  }
  return queue;
}

export function enqueueDisconnectedSend(environmentId: EnvironmentId, send: DisconnectedSend) {
  queueFor(environmentId).enqueue(send);
  publish(environmentId);
  useQueueStore.setState(({ flushRequests }) => ({ flushRequests: flushRequests + 1 }));
}

const hasDisconnectedSends = (environmentId: EnvironmentId) =>
  (queues.get(environmentId)?.pending().length ?? 0) > 0;

/**
 * The server answered the command and said no: its typed dispatch error, as opposed to a socket
 * or transport failure where it may never have seen the command.
 */
function refusalReason(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "OrchestrationV2DispatchCommandError" &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : undefined;
}

/**
 * Sends them first in, first out. A refusal is terminal for that message (kept as refused, never
 * replayed) and delivery goes on; anything else that fails leaves every message held for Retry.
 */
async function flushDisconnectedSends(
  environmentId: EnvironmentId,
  send: (command: DisconnectedSend) => Promise<unknown>,
): Promise<void> {
  setStalled(environmentId, false);
  try {
    await queueFor(environmentId).flush(async (command) => {
      try {
        await send(command);
      } catch (error) {
        const reason = refusalReason(error);
        if (reason !== undefined) throw new DisconnectedComposerRefusal(reason);
        throw error;
      }
    });
  } catch (error) {
    setStalled(environmentId, true);
    throw error;
  } finally {
    publish(environmentId);
  }
}

/**
 * Delivers what every given (connected) environment holds. A failure in transit keeps the held
 * messages, marks the environment as stalled and does not retry on its own; that is left to Retry.
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

/** The user asked to deliver the held messages again after a transit failure; same commands. */
export function retryDisconnectedSends(environmentId: EnvironmentId) {
  setStalled(environmentId, false);
  useQueueStore.setState(({ flushRequests }) => ({ flushRequests: flushRequests + 1 }));
}

/**
 * Sends a refused message again, same text under a new command id and message id, in its old
 * place. The refused id stays rejected on the server, so it is never replayed.
 */
export function resendDisconnectedSend(environmentId: EnvironmentId, commandId: CommandId) {
  const queue = queueFor(environmentId);
  const refused = queue.pending().find((send) => send.commandId === commandId);
  if (refused === undefined || queue.refusal(commandId) === undefined) return;
  queue.replace(commandId, {
    ...refused,
    commandId: CommandId.make(randomUUID()),
    message: { ...refused.message, messageId: newMessageId() },
  });
  publish(environmentId);
  useQueueStore.setState(({ flushRequests }) => ({ flushRequests: flushRequests + 1 }));
}

/** Drops a held message for good; the messages of its thread that waited behind it go on. */
export function discardDisconnectedSend(environmentId: EnvironmentId, commandId: CommandId) {
  if (!queueFor(environmentId).remove(commandId)) return;
  publish(environmentId);
  useQueueStore.setState(({ flushRequests }) => ({ flushRequests: flushRequests + 1 }));
}

/** Changes when held messages should be delivered now (a new one, or a Retry). */
export const useDisconnectedFlushRequests = () => useQueueStore((store) => store.flushRequests);

/** Whether a delivery to this environment failed in transit and is waiting for Retry. */
export const useDisconnectedSendsStalled = (environmentId: EnvironmentId) =>
  useQueueStore((store) => store.stalled.has(environmentId));

/** The reasons the server gave for refusing held messages of this environment, by command id. */
export const useDisconnectedSendRefusals = (environmentId: EnvironmentId): Refusals =>
  useQueueStore((store) => store.refusals[environmentId] ?? NO_REFUSALS);

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
export const isDisconnectedSendsStalled = (environmentId: EnvironmentId) =>
  useQueueStore.getState().stalled.has(environmentId);
export const disconnectedSendRefusals = (environmentId: EnvironmentId): Refusals =>
  useQueueStore.getState().refusals[environmentId] ?? NO_REFUSALS;

/** Test seam: forget every queue and outcome. */
export function resetDisconnectedSendsForTest() {
  queues.clear();
  useQueueStore.setState({ held: {}, refusals: {}, flushRequests: 0, stalled: new Set() });
}
