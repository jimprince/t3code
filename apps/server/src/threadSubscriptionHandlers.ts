import { ThreadSubscriptionsError, WS_METHODS, type ThreadId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";
import type { ThreadManagementService } from "./orchestration-v2/ThreadManagementService.ts";
import { listThreadSubscriptions, updateThreadSubscriptions } from "./threadSubscriptions.ts";

const isSubscriptionError = Schema.is(ThreadSubscriptionsError);

/** Transport validates the environment-local target before touching operator routes. */
export function threadSubscriptionHandlers(threads: ThreadManagementService["Service"]) {
  const withThread = <A>(threadId: ThreadId, action: () => Promise<A>) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap(() =>
        Effect.tryPromise({
          try: action,
          catch: (cause) =>
            new ThreadSubscriptionsError({
              message: cause instanceof Error ? cause.message : "Cannot manage subscriptions.",
            }),
        }),
      ),
      Effect.mapError((cause) =>
        isSubscriptionError(cause)
          ? cause
          : new ThreadSubscriptionsError({ message: "Cannot read selected thread." }),
      ),
    );
  return {
    [WS_METHODS.serverThreadSubscriptions]: (input: { threadId: ThreadId }) =>
      withThread(input.threadId, () => listThreadSubscriptions(input.threadId)),
    [WS_METHODS.serverUpdateThreadSubscriptions]: (
      input: typeof import("@t3tools/contracts").UpdateThreadSubscriptionsInput.Type,
    ) => withThread(input.threadId, () => updateThreadSubscriptions(input)),
  };
}
