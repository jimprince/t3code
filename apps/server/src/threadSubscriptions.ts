import { ThreadSubscription, type UpdateThreadSubscriptionsInput } from "@t3tools/contracts";
import { loadState, updateState } from "@t3tools/shared/threadRoutingState";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as DateTime from "effect/DateTime";

type RoutingState = Record<string, unknown>;
const empty: RoutingState = {};
const decodeRoute = Schema.decodeUnknownSync(ThreadSubscription);
function routesOf(state: RoutingState) {
  return Array.isArray(state.subscriptions)
    ? state.subscriptions.map((route) => decodeRoute(route))
    : [];
}

/** Only public route metadata leaves the host; the credential-bearing state stays here. */
export async function listThreadSubscriptions(threadId: string) {
  return {
    routes: routesOf(await loadState(empty)).filter(
      (route) => route.subscriberThreadId === threadId,
    ),
  };
}

/** Uses the CLI's lock and atomic rename so a running watcher cannot lose unrelated state. */
export async function updateThreadSubscriptions(input: typeof UpdateThreadSubscriptionsInput.Type) {
  if (input.routes.some((route) => route.subscriberThreadId !== input.threadId)) {
    throw new Error("Every route must belong to the selected subscriber thread.");
  }
  return updateState(empty, (state) => {
    const routes = routesOf(state);
    const sources = new Set(input.routes.map((route) => route.sourceThreadId));
    const matches = (route: ThreadSubscription) =>
      route.subscriberThreadId === input.threadId && sources.has(route.sourceThreadId);
    const removed = routes.filter(matches);
    const stored = Array.isArray(state.subscriptions) ? state.subscriptions : [];
    const subscriptions =
      input.action === "remove"
        ? stored.filter((route) => !matches(decodeRoute(route)))
        : [
            ...stored,
            ...input.routes.filter(
              (route) =>
                !routes.some(
                  (current) =>
                    current.subscriberThreadId === route.subscriberThreadId &&
                    current.sourceThreadId === route.sourceThreadId,
                ),
            ),
          ];
    const notifications =
      input.action === "remove" && Array.isArray(state.notifications)
        ? state.notifications.map((notification) =>
            Predicate.isObject(notification) &&
            notification.subscriberThreadId === input.threadId &&
            sources.has(String(notification.sourceThreadId)) &&
            !["delivered", "superseded", "undeliverable"].includes(String(notification.status))
              ? {
                  ...notification,
                  status: "superseded",
                  updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                  nextAttemptAt: null,
                }
              : notification,
          )
        : state.notifications;
    return {
      state: { ...state, subscriptions, ...(notifications === undefined ? {} : { notifications }) },
      result: { routes: input.action === "remove" ? removed : input.routes },
    };
  });
}
