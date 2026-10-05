import * as Schema from "effect/Schema";

export class GeneralChatInvariantError extends Schema.TaggedError<GeneralChatInvariantError>()(
  "GeneralChatInvariantError",
  { message: Schema.String },
) {}
