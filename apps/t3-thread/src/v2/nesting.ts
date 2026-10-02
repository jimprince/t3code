import { CommandId, EnvironmentAuthorizationError, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

// Narrow operator transport for the M2 fork sidecar, independent of native execution lineage.
const RemoteParent = Schema.Struct({ environmentId: Schema.String, threadId: ThreadId });
export const ThreadMetadata = Schema.Struct({
  threadId: ThreadId,
  parentThreadId: Schema.NullOr(ThreadId),
  scope: Schema.optionalKey(Schema.NullOr(Schema.String)),
  remoteParent: Schema.optionalKey(Schema.NullOr(RemoteParent)),
});
export type ThreadMetadata = typeof ThreadMetadata.Type;
export const ThreadMetadataUpdate = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  scope: Schema.optional(Schema.NullOr(Schema.String)),
  remoteParent: Schema.optional(Schema.NullOr(RemoteParent)),
});
class ForkThreadMetadataError extends Schema.TaggedError<ForkThreadMetadataError>()(
  "ForkThreadMetadataError",
  { message: Schema.String },
) {}
const error = Schema.Union([ForkThreadMetadataError, EnvironmentAuthorizationError]);
export const NestingRpcs = [
  Rpc.make("fork.threads.metadata.list", {
    payload: Schema.Struct({}),
    success: Schema.Array(ThreadMetadata),
    error,
  }),
  Rpc.make("fork.threads.metadata.update", {
    payload: ThreadMetadataUpdate,
    success: ThreadMetadata,
    error,
  }),
  Rpc.make("fork.threads.order.reset", {
    payload: Schema.Struct({ commandId: CommandId, threadId: ThreadId }),
    success: Schema.Void,
    error,
  }),
] as const;
export function withThreadMetadata<T extends { id: string; parentThreadId?: string | null }>(
  thread: T,
  rows: readonly ThreadMetadata[],
): T {
  const metadata = rows.find((row) => row.threadId === thread.id);
  return metadata
    ? {
        ...thread,
        parentThreadId: metadata.parentThreadId,
        remoteParent: metadata.remoteParent ?? null,
        scope: metadata.scope ?? null,
      }
    : thread;
}
