import * as Schema from "effect/Schema";
export const NotificationOrigin = Schema.Literals([
  "human",
  "worker",
  "routed",
  "automation",
  "unknown",
]);
export const NotificationKind = Schema.Literals([
  "reply",
  "question",
  "approval",
  "decision",
  "error",
  "attention",
]);
export const ThreadNotificationEvent = Schema.Struct({
  kind: NotificationKind,
  identity: Schema.String,
  origin: NotificationOrigin,
  occurredAt: Schema.String,
  errorReason: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(120))),
});
export type ThreadNotificationEvent = typeof ThreadNotificationEvent.Type;
