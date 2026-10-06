import * as Schema from "effect/Schema";

export const workerArchiveFields = {
  autoArchiveSettledBefore: Schema.optional(Schema.DateTimeUtc),
};
export const workerCompletionFields = { completionRunId: Schema.optional(Schema.String) };
