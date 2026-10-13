import * as Schema from "effect/Schema";
import { ThreadId } from "./baseSchemas.ts";

export const workerArchiveFields = {
  autoArchiveSettledBefore: Schema.optional(Schema.DateTimeUtc),
};
export const NativeCompletion = Schema.Struct({
  taskId: Schema.String,
  parentThreadId: ThreadId,
  startedAt: Schema.String,
  updatedAt: Schema.String,
});
export type NativeCompletion = typeof NativeCompletion.Type;
export const workerCompletionFields = {
  completionRunId: Schema.optional(Schema.String),
  nativeCompletion: Schema.optional(NativeCompletion),
};
