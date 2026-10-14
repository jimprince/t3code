import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { ThreadId, RunId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const ThreadResumeProvenance = Schema.Struct({
  threadId: ThreadId,
  lastRunId: Schema.NullOr(RunId),
});
export type ThreadResumeProvenance = typeof ThreadResumeProvenance.Type;
export const ThreadResumeFromPlanInput = Schema.Struct({
  threadId: ThreadId,
  modelSelection: Schema.optional(ModelSelection),
});
export type ThreadResumeFromPlanInput = typeof ThreadResumeFromPlanInput.Type;
export const ThreadResumeResult = Schema.Struct({ newThreadId: ThreadId, reused: Schema.Boolean });
export type ThreadResumeResult = typeof ThreadResumeResult.Type;
export const ThreadResumePreview = Schema.Struct({ seed: Schema.String });
export const ThreadResumeRefusalReason = Schema.Literals([
  "no_plan",
  "plan_complete",
  "still_running",
  "not_failed",
]);
export type ThreadResumeRefusalReason = typeof ThreadResumeRefusalReason.Type;
export class ThreadResumeError extends Schema.TaggedError<ThreadResumeError>()(
  "ThreadResumeError",
  {
    reason: Schema.Union([ThreadResumeRefusalReason, Schema.Literal("unavailable")]),
    message: Schema.String,
  },
) {}
export const ThreadResumeRpc = Rpc.make("thread.resumeFromPlan", {
  payload: ThreadResumeFromPlanInput,
  success: ThreadResumeResult,
  error: Schema.Union([ThreadResumeError, EnvironmentAuthorizationError]),
});

export const ThreadResumePreviewRpc = Rpc.make("thread.previewResumePlan", {
  payload: ThreadResumeFromPlanInput,
  success: ThreadResumePreview,
  error: Schema.Union([ThreadResumeError, EnvironmentAuthorizationError]),
});
