import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { ProjectId, ThreadId } from "./baseSchemas.ts";
import { ChatAttachmentId } from "./chatAttachment.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { OrchestrationV2ThreadProjectionJson } from "./orchestrationV2.ts";

const raw = Schema.Record(Schema.String, Schema.Unknown);
export const ThreadMoveAttachment = Schema.Struct({
  id: ChatAttachmentId,
  contentBase64: Schema.NullOr(Schema.String.check(Schema.isMaxLength(70_000_000))),
});
export type ThreadMoveAttachment = typeof ThreadMoveAttachment.Type;
export const ThreadMoveGitState = Schema.Struct({
  branch: Schema.String,
  branchTipSha: Schema.String,
  bundleBase64: Schema.NullOr(Schema.String.check(Schema.isMaxLength(100_000_000))),
  checkpointRefs: Schema.Array(Schema.String),
  dirtyDiff: Schema.NullOr(Schema.String),
  untrackedFiles: Schema.Array(
    Schema.Struct({ path: Schema.String, contentBase64: Schema.String }),
  ),
});
export type ThreadMoveGitState = typeof ThreadMoveGitState.Type;
const fields = {
  exportedAt: Schema.String,
  sourceProjectId: ProjectId,
  sourceWorkspaceRoot: Schema.String,
  repositoryIdentity: Schema.NullOr(raw),
  git: Schema.NullOr(ThreadMoveGitState),
  warnings: Schema.Array(Schema.String),
};
// Preserve the released payload verbatim, including retired goals and unknown historical fields.
export const ThreadMoveBundleV1 = Schema.Struct({
  version: Schema.Literal(1),
  ...fields,
  thread: raw,
  providerSession: Schema.NullOr(raw),
});
export const ThreadMoveBundleV2 = Schema.Struct({
  version: Schema.Literal(2),
  ...fields,
  thread: raw,
  providerSession: Schema.NullOr(raw),
  attachments: Schema.Array(ThreadMoveAttachment),
});
export const ThreadMoveBundleV3 = Schema.Struct({
  version: Schema.Literal(3),
  ...fields,
  sourceEnvironmentId: Schema.optional(Schema.String),
  projection: OrchestrationV2ThreadProjectionJson,
  metadata: raw,
  history: raw,
  legacyBundle: Schema.NullOr(raw),
  attachments: Schema.Array(ThreadMoveAttachment),
});
export const THREAD_MOVE_BUNDLE_VERSION = 3;
export const ThreadMoveBundle = Schema.Union([
  ThreadMoveBundleV1,
  ThreadMoveBundleV2,
  ThreadMoveBundleV3,
]);
export type ThreadMoveBundle = typeof ThreadMoveBundle.Type;
export const OrchestrationExportThreadInput = Schema.Struct({ threadId: ThreadId });
export type OrchestrationExportThreadInput = typeof OrchestrationExportThreadInput.Type;
export const OrchestrationExportThreadResult = Schema.Struct({ bundle: ThreadMoveBundle });
export type OrchestrationExportThreadResult = typeof OrchestrationExportThreadResult.Type;
export const OrchestrationImportThreadInput = Schema.Struct({
  projectId: ProjectId,
  bundle: ThreadMoveBundle,
  branchConflict: Schema.optional(Schema.Literals(["fail", "new-worktree"])),
});
export type OrchestrationImportThreadInput = typeof OrchestrationImportThreadInput.Type;
export const OrchestrationImportThreadResult = Schema.Struct({
  threadId: ThreadId,
  worktreePath: Schema.NullOr(Schema.String),
  warnings: Schema.Array(Schema.String),
  receipt: Schema.String,
  durable: Schema.Literal(true),
});
export type OrchestrationImportThreadResult = typeof OrchestrationImportThreadResult.Type;
export class ThreadTransferError extends Schema.TaggedError<ThreadTransferError>()(
  "ThreadTransferError",
  {
    operation: Schema.String,
    reason: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Thread transfer failed during ${this.operation}.`;
  }
}
export const ThreadTransferRpcs = [
  Rpc.make("orchestration.exportThread", {
    payload: OrchestrationExportThreadInput,
    success: OrchestrationExportThreadResult,
    error: Schema.Union([ThreadTransferError, EnvironmentAuthorizationError]),
  }),
  Rpc.make("orchestration.importThread", {
    payload: OrchestrationImportThreadInput,
    success: OrchestrationImportThreadResult,
    error: Schema.Union([ThreadTransferError, EnvironmentAuthorizationError]),
  }),
] as const;
