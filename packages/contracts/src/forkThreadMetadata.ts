import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { CommandId, ThreadId } from "./baseSchemas.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const ForkRemoteParent = Schema.Struct({ environmentId: Schema.String, threadId: ThreadId });
export type ForkRemoteParent = typeof ForkRemoteParent.Type;

export const ThreadSubprojectMode = Schema.Literals(["auto", "on", "off"]);
export type ThreadSubprojectMode = typeof ThreadSubprojectMode.Type;

/** Organizational supervision is independent of provider execution lineage. */
export const ForkThreadMetadata = Schema.Struct({
  threadId: ThreadId,
  subproject: Schema.optionalKey(Schema.NullOr(ThreadSubprojectMode)),
  parentThreadId: Schema.NullOr(ThreadId),
  scope: Schema.optionalKey(Schema.NullOr(Schema.String)),
  settleOnComplete: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  remoteParent: Schema.optionalKey(Schema.NullOr(ForkRemoteParent)),
});
export type ForkThreadMetadata = typeof ForkThreadMetadata.Type;
export const ForkThreadMetadataUpdate = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  subproject: Schema.optionalKey(Schema.NullOr(ThreadSubprojectMode)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
  settleOnComplete: Schema.optional(Schema.NullOr(Schema.Boolean)),
  remoteParent: Schema.optional(Schema.NullOr(ForkRemoteParent)),
});
export type ForkThreadMetadataUpdate = typeof ForkThreadMetadataUpdate.Type;
export class ForkThreadMetadataError extends Schema.TaggedError<ForkThreadMetadataError>()(
  "ForkThreadMetadataError",
  { message: Schema.String },
) {}
const error = Schema.Union([ForkThreadMetadataError, EnvironmentAuthorizationError]);
export const ForkThreadMetadataRpcs = [
  Rpc.make("fork.threads.metadata.list", {
    payload: Schema.Struct({}),
    success: Schema.Array(ForkThreadMetadata),
    error,
  }),
  Rpc.make("fork.threads.metadata.update", {
    payload: ForkThreadMetadataUpdate,
    success: ForkThreadMetadata,
    error,
  }),
] as const;
