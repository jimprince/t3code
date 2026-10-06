import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { ThreadId, NonNegativeInt } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const LegacyHistorySection = Schema.Literals([
  "thread",
  "messages",
  "turns",
  "diffs",
  "tools",
  "plans",
  "goals",
  "events",
  "provenance",
]);
export type LegacyHistorySection = typeof LegacyHistorySection.Type;
export const LegacyHistoryOrigin = Schema.Literals(["v1", "transfer"]);
export type LegacyHistoryOrigin = typeof LegacyHistoryOrigin.Type;
export const LegacyHistoryInput = Schema.Struct({
  threadId: ThreadId,
  section: Schema.optional(LegacyHistorySection),
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type LegacyHistoryInput = typeof LegacyHistoryInput.Type;
export const LegacyHistoryResult = Schema.Struct({
  threadId: ThreadId,
  sourceThreadId: ThreadId,
  readOnly: Schema.Literal(true),
  restoreAllowed: Schema.Literal(false),
  sections: Schema.Array(LegacyHistorySection),
  origin: Schema.optional(LegacyHistoryOrigin),
  section: LegacyHistorySection,
  records: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type LegacyHistoryResult = typeof LegacyHistoryResult.Type;
export class LegacyHistoryError extends Schema.TaggedError<LegacyHistoryError>()(
  "LegacyHistoryError",
  {
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to read historical thread ${this.threadId}.`;
  }
}
export const LegacyHistoryRpc = Rpc.make("orchestration.getLegacyHistory", {
  payload: LegacyHistoryInput,
  success: LegacyHistoryResult,
  error: Schema.Union([LegacyHistoryError, EnvironmentAuthorizationError]),
});
