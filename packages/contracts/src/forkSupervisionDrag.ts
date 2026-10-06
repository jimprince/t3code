import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const SupervisionDrop = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  pinned: Schema.optional(Schema.Boolean),
  section: Schema.optional(Schema.Literals(["pinned", "active", "settled"])),
  assignments: Schema.optional(
    Schema.Array(Schema.Struct({ threadId: ThreadId, orderKey: Schema.String })),
  ),
  orderKey: Schema.optional(Schema.String),
});
export type SupervisionDrop = typeof SupervisionDrop.Type;
export class SupervisionDropError extends Schema.TaggedError<SupervisionDropError>()(
  "SupervisionDropError",
  { message: Schema.String },
) {}
export const SupervisionDropRpc = Rpc.make("fork.threads.supervision.drop", {
  payload: SupervisionDrop,
  success: Schema.Void,
  error: Schema.Union([SupervisionDropError, EnvironmentAuthorizationError]),
});
