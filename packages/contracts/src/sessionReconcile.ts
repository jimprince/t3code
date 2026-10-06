import { CommandId, ThreadId } from "./baseSchemas.ts";
import * as Schema from "effect/Schema";

export const SessionReconcileInput = Schema.Struct({ commandId: CommandId, threadId: ThreadId });
export class SessionReconcileError extends Schema.TaggedError<SessionReconcileError>()(
  "SessionReconcileError",
  { message: Schema.String },
) {}
