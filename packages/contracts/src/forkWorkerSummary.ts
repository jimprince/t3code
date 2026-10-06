import * as Schema from "effect/Schema";

/** Derived V2 data. Imported V1 tools and usage are intentionally unavailable here. */
export const ForkWorkerSummary = Schema.Struct({
  output: Schema.NullOr(Schema.String),
  messageCount: Schema.Number,
  toolCount: Schema.Number,
  usedTokens: Schema.NullOr(Schema.Number),
  activity: Schema.NullOr(Schema.String),
  history: Schema.Literals(["v2", "legacy-unavailable"]),
});
export type ForkWorkerSummary = typeof ForkWorkerSummary.Type;
