import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { OrchestrationV2ThreadForkSourcePoint } from "./orchestrationV2.ts";

export const ForkConversationInput = Schema.Struct({
  commandId: CommandId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  sourcePoint: OrchestrationV2ThreadForkSourcePoint,
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1))),
  workspaceMode: Schema.Literals(["current", "new-worktree"]),
});
export type ForkConversationInput = typeof ForkConversationInput.Type;
export const ForkConversationResult = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.NullOr(Schema.String),
});
export type ForkConversationResult = typeof ForkConversationResult.Type;
export class ForkConversationError extends Schema.TaggedError<ForkConversationError>()(
  "ForkConversationError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Conversation fork failed during ${this.operation}.`;
  }
}
export const ForkConversationRpc = Rpc.make("orchestration.forkThread", {
  payload: ForkConversationInput,
  success: ForkConversationResult,
  error: Schema.Union([ForkConversationError, EnvironmentAuthorizationError]),
});
