import { loadState, updateState } from "./state.js";
import type { SavedSubscription } from "./types.js";

/** Record accepted direct results against the source turn, including durable queued sends. */
export async function sendDirectResult<T>(input: {
  callerThreadId: string | null;
  subscriberThreadId: string;
  getSourceTurn: (route: SavedSubscription) => Promise<string | null>;
  send: () => Promise<T>;
}): Promise<T> {
  const state = await loadState();
  const route = state.subscriptions.find(
    (subscription) =>
      subscription.sourceThreadId === input.callerThreadId &&
      subscription.subscriberThreadId === input.subscriberThreadId,
  );
  // An unreachable source must not prevent a message reaching its recipient.
  const turnId = route ? await input.getSourceTurn(route).catch(() => null) : null;
  const outcome = await input.send();
  if (route && turnId) {
    await updateState((current) => ({
      state: {
        ...current,
        subscriptions: current.subscriptions.map((subscription) =>
          subscription.sourceThreadId === route.sourceThreadId &&
          subscription.subscriberThreadId === route.subscriberThreadId
            ? { ...subscription, lastDirectMessageTurnId: turnId }
            : subscription,
        ),
      },
      result: null,
    }));
  }
  return outcome;
}
