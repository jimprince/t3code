import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

/** Organizational supervision is independent of provider execution lineage. */
export const ForkThreadMetadata = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
});
export type ForkThreadMetadata = typeof ForkThreadMetadata.Type;
export const ForkThreadMetadataUpdate = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type ForkThreadMetadataUpdate = typeof ForkThreadMetadataUpdate.Type;
export class ForkThreadMetadataError extends Schema.TaggedError<ForkThreadMetadataError>()(
  "ForkThreadMetadataError", { message: Schema.String },
) {}
const error = Schema.Union([ForkThreadMetadataError, EnvironmentAuthorizationError]);
export const ForkThreadMetadataRpcs = [
  Rpc.make("fork.threads.metadata.list", { payload: Schema.Struct({}), success: Schema.Array(ForkThreadMetadata), error }),
  Rpc.make("fork.threads.metadata.update", { payload: ForkThreadMetadataUpdate, success: ForkThreadMetadata, error }),
] as const;
