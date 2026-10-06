import {
  MessageId,
  ModelSelection,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type ThreadMoveBundle,
  OrchestrationV2ThreadProjectionJson,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { collectTransferAttachments } from "./TransferAttachments.ts";

const LegacyMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant", "system"]),
  text: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  context: Schema.optional(OrchestrationMessageContext),
  attachments: Schema.optional(Schema.Array(Schema.Unknown)),
  fileAttachments: Schema.optional(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
});
const LegacyThread = Schema.Struct({
  id: ThreadId,
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  branch: Schema.NullOr(Schema.String),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
  messages: Schema.Array(LegacyMessage),
});

const decodeLegacyThread = Schema.decodeUnknownSync(LegacyThread);
const encodeProjection = Schema.encodeSync(OrchestrationV2ThreadProjectionJson);

export function transferConversation(bundle: ThreadMoveBundle): {
  thread: OrchestrationV2AppThread;
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
} {
  if (bundle.version === 3)
    return { thread: bundle.projection.thread, messages: bundle.projection.messages };
  const old = decodeLegacyThread(bundle.thread);
  const thread: OrchestrationV2AppThread = {
    id: old.id,
    projectId: bundle.sourceProjectId,
    title: old.title,
    modelSelection: old.modelSelection,
    providerInstanceId: old.modelSelection.instanceId,
    runtimeMode: old.runtimeMode,
    interactionMode: old.interactionMode,
    branch: old.branch,
    worktreePath: null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, rootThreadId: old.id, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "system",
    creationSource: "server",
    createdAt: old.createdAt,
    updatedAt: old.updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const messages = old.messages.map((message) => ({
    id: message.id,
    threadId: old.id,
    runId: null,
    nodeId: null,
    role: message.role,
    text: message.text,
    ...(message.context === undefined ? {} : { context: message.context }),
    attachments: collectTransferAttachments([
      ...(message.attachments ?? []),
      ...(message.fileAttachments ?? []).map((file) => ({ ...file, type: "file" })),
    ]),
    streaming: false,
    createdBy: "user" as const,
    creationSource: "server" as const,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  }));
  return { thread, messages };
}

/** Storage paths and attachment bindings in context records travel; transcript prose and lossless evidence do not change. */
export function rewriteTransferContext(
  value: unknown,
  oldRoot: string,
  newRoot: string,
  attachments?: ReadonlyMap<string, { readonly id: string }>,
): unknown {
  if (typeof value === "string")
    return value === oldRoot
      ? newRoot
      : value.startsWith(`${oldRoot}/`)
        ? `${newRoot}${value.slice(oldRoot.length)}`
        : value;
  if (Array.isArray(value))
    return value.map((item) => rewriteTransferContext(item, oldRoot, newRoot, attachments));
  if (Predicate.isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "attachmentId" && typeof item === "string"
          ? (attachments?.get(item)?.id ?? item)
          : rewriteTransferContext(item, oldRoot, newRoot, attachments),
      ]),
    );
  return value;
}
export function encodedProjection(projection: typeof OrchestrationV2ThreadProjectionJson.Type) {
  return encodeProjection(projection);
}
