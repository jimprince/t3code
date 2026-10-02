import * as Rpc from "effect/unstable/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

/** Public route metadata, without the operator's environment credentials. */
export const ThreadSubscription = Schema.Struct({
  subscriberThreadId: Schema.String,
  subscriberAgentName: Schema.NullOr(Schema.String),
  subscriberEnvironment: Schema.String,
  sourceThreadId: Schema.String,
  sourceAgentName: Schema.NullOr(Schema.String),
  sourceEnvironment: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  baselineTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  level: Schema.optionalKey(Schema.Literals(["all", "attention", "none"])),
  inputReminderMinutes: Schema.optionalKey(Schema.Number),
  lastDirectMessageTurnId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  errorEventKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  observedState: Schema.optionalKey(Schema.String),
  observedReason: Schema.optionalKey(Schema.String),
});
export type ThreadSubscription = typeof ThreadSubscription.Type;
export const ThreadSubscriptionsInput = Schema.Struct({ threadId: ThreadId });
export const ThreadSubscriptionsResult = Schema.Struct({
  routes: Schema.Array(ThreadSubscription),
});
export const UpdateThreadSubscriptionsInput = Schema.Struct({
  threadId: ThreadId,
  action: Schema.Literals(["remove", "restore"]),
  routes: Schema.Array(ThreadSubscription),
});
export class ThreadSubscriptionsError extends Schema.TaggedError<ThreadSubscriptionsError>()(
  "ThreadSubscriptionsError",
  { message: Schema.String },
) {}

/** Fork RPCs kept outside the upstream method catalog. */
export const THREAD_SUBSCRIPTION_METHODS = {
  serverThreadSubscriptions: "server.threadSubscriptions",
  serverUpdateThreadSubscriptions: "server.updateThreadSubscriptions",
} as const;

export const ThreadSubscriptionRpcs = [
  Rpc.make(THREAD_SUBSCRIPTION_METHODS.serverThreadSubscriptions, {
    payload: ThreadSubscriptionsInput,
    success: ThreadSubscriptionsResult,
    error: Schema.Union([EnvironmentAuthorizationError, ThreadSubscriptionsError]),
  }),
  Rpc.make(THREAD_SUBSCRIPTION_METHODS.serverUpdateThreadSubscriptions, {
    payload: UpdateThreadSubscriptionsInput,
    success: ThreadSubscriptionsResult,
    error: Schema.Union([EnvironmentAuthorizationError, ThreadSubscriptionsError]),
  }),
] as const;
