import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  type ChatAttachment,
  type ClientOrchestrationCommand,
  CHAT_FILE_ATTACHMENT_MAX_BYTES,
  type UserInputAttachments,
  getProviderAttachmentLimitError,
  type IsoDateTime,
  type OrchestrationCommand,
  OrchestrationDispatchCommandError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

import {
  attachmentFileExtension,
  createAttachmentId,
  planAttachmentClaim,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";

export const canonicalizeClientCommandTimestamps = (
  command: ClientOrchestrationCommand,
  receivedAt: IsoDateTime,
): ClientOrchestrationCommand => {
  const canonicalCommand =
    "createdAt" in command
      ? {
          ...command,
          createdAt: receivedAt,
        }
      : command;

  if (canonicalCommand.type !== "thread.turn.start" || !canonicalCommand.bootstrap?.createThread) {
    return canonicalCommand;
  }

  return {
    ...canonicalCommand,
    bootstrap: {
      ...canonicalCommand.bootstrap,
      createThread: {
        ...canonicalCommand.bootstrap.createThread,
        createdAt: receivedAt,
      },
    },
  };
};

const removeClaimedAttachmentPaths = Effect.fn("Normalizer.removeClaimedAttachmentPaths")(
  function* (attachmentPaths: ReadonlyArray<string>) {
    if (attachmentPaths.length === 0) {
      return;
    }
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      attachmentPaths,
      (attachmentPath) =>
        fileSystem.remove(attachmentPath, { force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to remove an unclaimed attachment copy.", {
              attachmentPath,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      { concurrency: 1 },
    );
  },
);

export const normalizeDispatchCommand = (command: ClientOrchestrationCommand) =>
  Effect.gen(function* () {
    const receivedAt = DateTime.formatIso(yield* DateTime.now);
    const canonicalCommand = canonicalizeClientCommandTimestamps(command, receivedAt);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;
    const workspacePaths = yield* WorkspacePaths.WorkspacePaths;

    const normalizeProjectWorkspaceRoot = (workspaceRoot: string) =>
      workspacePaths.normalizeWorkspaceRoot(workspaceRoot).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationDispatchCommandError({
              message: cause.message,
            }),
        ),
      );

    const normalizeProjectWorkspaceRootForCreate = (
      workspaceRoot: string,
      createIfMissing: boolean | undefined,
    ) =>
      workspacePaths
        .normalizeWorkspaceRoot(workspaceRoot, {
          createIfMissing: createIfMissing === true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: cause.message,
              }),
          ),
        );

    if (canonicalCommand.type === "project.create") {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRootForCreate(
          canonicalCommand.workspaceRoot,
          canonicalCommand.createWorkspaceRootIfMissing,
        ),
        createWorkspaceRootIfMissing: canonicalCommand.createWorkspaceRootIfMissing === true,
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type === "project.meta.update" &&
      canonicalCommand.workspaceRoot !== undefined
    ) {
      return {
        ...canonicalCommand,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(canonicalCommand.workspaceRoot),
      } satisfies OrchestrationCommand;
    }

    if (
      canonicalCommand.type !== "thread.turn.start" &&
      canonicalCommand.type !== "thread.user-input.respond"
    ) {
      return canonicalCommand as OrchestrationCommand;
    }

    const attachments =
      canonicalCommand.type === "thread.turn.start"
        ? canonicalCommand.message.attachments
        : Object.values(canonicalCommand.attachmentsByQuestionId ?? {}).flat();
    const attachmentLimitError = getProviderAttachmentLimitError(attachments);
    if (attachmentLimitError) {
      return yield* new OrchestrationDispatchCommandError({ message: attachmentLimitError });
    }
    if (canonicalCommand.type === "thread.turn.start") {
      const clientAttachmentIds = new Set<string>();
      for (const attachment of attachments) {
        if (attachment.id === undefined) continue;
        if (clientAttachmentIds.has(attachment.id)) {
          return yield* new OrchestrationDispatchCommandError({
            message: `Attachment '${attachment.name}' cannot be sent: duplicate attachment id.`,
          });
        }
        clientAttachmentIds.add(attachment.id);
      }
    }
    const persistedAttachmentPaths: string[] = [];
    const attachmentsWithDecodedSizes = [...attachments];
    // Context records bind to attachments by the id the client knew; they follow the rename.
    const finalAttachmentIdByClientId = new Map<string, string>();
    const normalizedAttachments = yield* Effect.forEach(
      attachments,
      (attachment, index) =>
        Effect.gen(function* () {
          if (!("dataUrl" in attachment)) {
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: canonicalCommand.threadId,
              attachmentId: attachment.id,
            });
            if (!claim.ok) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            }

            const info = yield* fileSystem.stat(claim.currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }

            const normalizedAttachment = {
              ...attachment,
              id: claim.finalId,
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalizedAttachment,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new OrchestrationDispatchCommandError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }

            // Keep the pending copy until the turn succeeds. A failed thread
            // bootstrap can then retry with a fresh thread id. A copy, not a
            // hard link: an agent editing the delivered file in place must not
            // mutate the retry source.
            yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationDispatchCommandError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
              ),
            );
            persistedAttachmentPaths.push(claim.finalPath);
            finalAttachmentIdByClientId.set(attachment.id, claim.finalId);

            return normalizedAttachment;
          }

          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(canonicalCommand.threadId);
          if (!attachmentId) {
            return yield* new OrchestrationDispatchCommandError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
            ...(attachment.source ? { source: attachment.source } : {}),
          };
          attachmentsWithDecodedSizes[index] = persistedAttachment;
          const decodedLimitError = getProviderAttachmentLimitError(attachmentsWithDecodedSizes);
          if (decodedLimitError) {
            return yield* new OrchestrationDispatchCommandError({ message: decodedLimitError });
          }

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new OrchestrationDispatchCommandError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new OrchestrationDispatchCommandError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );
          persistedAttachmentPaths.push(attachmentPath);
          if (attachment.id !== undefined) {
            finalAttachmentIdByClientId.set(attachment.id, attachmentId);
          }

          return persistedAttachment;
        }),
      { concurrency: 1 },
    ).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(persistedAttachmentPaths)));

    if (canonicalCommand.type === "thread.user-input.respond") {
      let index = 0;
      const attachmentsByQuestionId = Object.fromEntries(
        Object.entries(canonicalCommand.attachmentsByQuestionId ?? {}).map(
          ([questionId, original]) => {
            const claimed = normalizedAttachments.slice(
              index,
              index + original.length,
            ) as UserInputAttachments[string];
            index += original.length;
            return [questionId, claimed];
          },
        ),
      );
      return {
        ...canonicalCommand,
        ...(attachments.length > 0 ? { attachmentsByQuestionId } : {}),
      };
    }
    return yield* Effect.gen(function* () {
      const uploadFileAttachments = canonicalCommand.message.fileAttachments;
      // Legacy handoffs are appended to the provider attachment list on dispatch,
      // so they share upstream's per-message count and image-payload budget.
      const budgetedAttachments: Array<Pick<ChatAttachment, "type" | "mimeType" | "sizeBytes">> = [
        ...normalizedAttachments,
        ...(uploadFileAttachments ?? []),
      ];
      if (uploadFileAttachments !== undefined) {
        const uploadLimitError = getProviderAttachmentLimitError(budgetedAttachments);
        if (uploadLimitError) {
          return yield* new OrchestrationDispatchCommandError({ message: uploadLimitError });
        }
      }
      const normalizedFileAttachments =
        uploadFileAttachments === undefined
          ? undefined
          : yield* Effect.forEach(
              uploadFileAttachments,
              (attachment, index) =>
                Effect.gen(function* () {
                  const parsed = parseBase64DataUrl(attachment.dataUrl);
                  if (!parsed) {
                    return yield* new OrchestrationDispatchCommandError({
                      message: `Invalid file attachment payload for '${attachment.name}'.`,
                    });
                  }
                  const bytes = Buffer.from(parsed.base64, "base64");
                  if (bytes.byteLength === 0 || bytes.byteLength > CHAT_FILE_ATTACHMENT_MAX_BYTES) {
                    return yield* new OrchestrationDispatchCommandError({
                      message: `File attachment '${attachment.name}' is empty or too large.`,
                    });
                  }
                  const attachmentId = createAttachmentId(
                    canonicalCommand.threadId,
                    attachmentFileExtension(attachment.name),
                  );
                  if (!attachmentId) {
                    return yield* new OrchestrationDispatchCommandError({
                      message: "Failed to create a safe attachment id.",
                    });
                  }
                  const nativeAttachment = {
                    type: "file" as const,
                    id: attachmentId,
                    name: attachment.name,
                    mimeType: attachment.mimeType.toLowerCase(),
                    sizeBytes: bytes.byteLength,
                  };
                  budgetedAttachments[normalizedAttachments.length + index] = nativeAttachment;
                  const decodedLimitError = getProviderAttachmentLimitError(budgetedAttachments);
                  if (decodedLimitError) {
                    return yield* new OrchestrationDispatchCommandError({
                      message: decodedLimitError,
                    });
                  }
                  const attachmentPath = resolveAttachmentPath({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachment: nativeAttachment,
                  });
                  if (!attachmentPath) {
                    return yield* new OrchestrationDispatchCommandError({
                      message: `Failed to resolve persisted path for '${attachment.name}'.`,
                    });
                  }
                  yield* fileSystem
                    .makeDirectory(path.dirname(attachmentPath), { recursive: true })
                    .pipe(
                      Effect.mapError(
                        () =>
                          new OrchestrationDispatchCommandError({
                            message: `Failed to create attachment directory for '${attachment.name}'.`,
                          }),
                      ),
                    );
                  yield* Effect.scoped(
                    Effect.gen(function* () {
                      const file = yield* fileSystem.open(attachmentPath, { flag: "wx" });
                      persistedAttachmentPaths.push(attachmentPath);
                      yield* file.writeAll(bytes);
                    }),
                  ).pipe(
                    Effect.mapError(
                      () =>
                        new OrchestrationDispatchCommandError({
                          message: `Failed to persist file attachment '${attachment.name}'.`,
                        }),
                    ),
                  );
                  return { ...nativeAttachment, path: attachmentPath };
                }),
              { concurrency: 1 },
            );
      const context = canonicalCommand.message.context;
      const normalizedContext =
        context === undefined
          ? undefined
          : {
              ...context,
              records: context.records.map((record) =>
                (record.kind === "image" || record.kind === "file") && "attachmentId" in record
                  ? {
                      ...record,
                      attachmentId:
                        finalAttachmentIdByClientId.get(record.attachmentId) ?? record.attachmentId,
                    }
                  : record,
              ),
            };

      // Strip the client upload shape so only normalized (path-bearing) file
      // attachments survive into the orchestration command.
      const { fileAttachments: _uploadShape, ...clientMessage } = canonicalCommand.message;
      return {
        ...canonicalCommand,
        message: {
          ...clientMessage,
          attachments: normalizedAttachments,
          ...(normalizedContext !== undefined ? { context: normalizedContext } : {}),
          ...(normalizedFileAttachments !== undefined
            ? { fileAttachments: normalizedFileAttachments }
            : {}),
        },
      } satisfies OrchestrationCommand;
    }).pipe(Effect.tapError(() => removeClaimedAttachmentPaths(persistedAttachmentPaths)));
  });

export const cleanupFailedUploadedAttachments = Effect.fn(
  "Normalizer.cleanupFailedUploadedAttachments",
)(function* (command: ClientOrchestrationCommand, normalizedCommand: OrchestrationCommand) {
  const originalAttachments =
    command.type === "thread.turn.start"
      ? command.message.attachments
      : command.type === "thread.user-input.respond"
        ? Object.values(command.attachmentsByQuestionId ?? {}).flat()
        : [];
  const normalizedAttachments =
    normalizedCommand.type === "thread.turn.start"
      ? normalizedCommand.message.attachments
      : normalizedCommand.type === "thread.user-input.respond"
        ? Object.values(normalizedCommand.attachmentsByQuestionId ?? {}).flat()
        : [];
  const serverConfig = yield* ServerConfig;
  const claimedPaths: string[] = [];
  for (const [index, attachment] of normalizedAttachments.entries()) {
    const original = originalAttachments[index];
    if (!original) {
      continue;
    }
    if (
      !("dataUrl" in original) &&
      parseThreadSegmentFromAttachmentId(original.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      continue;
    }

    const claimedPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (claimedPath) {
      claimedPaths.push(claimedPath);
    }
  }
  if (command.type === "thread.turn.start" && normalizedCommand.type === "thread.turn.start") {
    for (const [index, attachment] of (normalizedCommand.message.fileAttachments ?? []).entries()) {
      if (command.message.fileAttachments?.[index] === undefined) {
        continue;
      }
      const nativePath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      if (nativePath === attachment.path) {
        claimedPaths.push(nativePath);
      }
    }
  }
  yield* removeClaimedAttachmentPaths(claimedPaths);
});
