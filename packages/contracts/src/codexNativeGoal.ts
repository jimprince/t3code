import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Read-only projection of the native goal owned by Codex app-server. */
export const CodexNativeGoalSummary = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: Schema.Literals(["active", "completed", "blocked", "paused"]),
  tokensUsed: Schema.optional(NonNegativeInt),
  tokenBudget: Schema.optional(NonNegativeInt),
});
export type CodexNativeGoalSummary = typeof CodexNativeGoalSummary.Type;
