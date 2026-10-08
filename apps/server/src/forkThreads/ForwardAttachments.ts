import { copyStoredAttachments } from "./TransferAttachments.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import {
  MessageForwardError,
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { stableStringify } from "@t3tools/shared/relaySigning";
import * as Config from "../config.ts";
import {
  resolveAttachmentPath,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
} from "../attachmentStore.ts";

export const validateForwardAttachments = (references: ReadonlyArray<ChatAttachment>) => {
  const limit = getProviderAttachmentLimitError(references);
  if (limit) return Effect.fail(new MessageForwardError({ message: limit }));
  if (
    new Set(references.map((item) => item.id)).size !== references.length ||
    references.some(
      (item) =>
        (item.type !== "image" && item.type !== "file") ||
        item.sizeBytes >
          (item.type === "image"
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES),
    )
  )
    return Effect.fail(
      new MessageForwardError({
        message:
          "Forwarding requires every original image or file attachment, within the existing attachment limits.",
      }),
    );
  return Effect.void;
};

const storedPath = (directory: string, attachment: ChatAttachment) => {
  const file = resolveAttachmentPath({ attachmentsDir: directory, attachment });
  if (!file) throw new Error("Invalid attachment storage path.");
  return file;
};

export const verifyForwardAttachments = Effect.fn("ForwardAttachments.verify")(function* (
  references: ReadonlyArray<ChatAttachment>,
) {
  yield* validateForwardAttachments(references);
  const cfg = yield* Config.ServerConfig;
  yield* Effect.tryPromise({
    try: async () => {
      for (const reference of references) {
        const info = await NodeFSP.lstat(storedPath(cfg.attachmentsDir, reference));
        if (!info.isFile() || info.size !== reference.sizeBytes)
          throw new Error("Stored attachment missing or changed.");
      }
    },
    catch: () =>
      new MessageForwardError({
        message:
          "Every source attachment must exist in the attachment store with its original size.",
      }),
  });
});

/** One file at a time, no base64 transcript or temporary files outside the store.
 * Stable destination IDs allow a fresh staged upload on an explicit same-ID retry.
 */
export const claimForwardAttachments = Effect.fn("ForwardAttachments.claim")(function* (input: {
  recipientThreadId: string;
  sendId: string;
  references: ReadonlyArray<ChatAttachment>;
  stagedAttachments?: ReadonlyArray<ChatAttachment>;
}) {
  yield* validateForwardAttachments(input.references);
  const staged = input.stagedAttachments;
  if (
    staged !== undefined &&
    (staged.length !== input.references.length ||
      new Set(staged.map((item) => item.id)).size !== staged.length ||
      staged.some(
        (item, index) =>
          parseThreadSegmentFromAttachmentId(item.id) !== PENDING_ATTACHMENT_THREAD_SEGMENT ||
          stableStringify({ ...item, id: input.references[index]!.id }) !==
            stableStringify(input.references[index]),
      ))
  )
    return yield* new MessageForwardError({
      message:
        "Supply one matching pending upload for every source attachment, in the original order.",
    });
  const cfg = yield* Config.ServerConfig;
  return yield* copyStoredAttachments({
    attachmentsDir: cfg.attachmentsDir,
    recipientThreadId: input.recipientThreadId,
    stableKey: input.sendId,
    references: input.references,
    ...(staged === undefined ? {} : { sourceReferences: staged }),
  }).pipe(
    Effect.mapError(
      () =>
        new MessageForwardError({
          message:
            "Unable to copy every attachment into the target attachment store; no message was sent.",
        }),
    ),
  );
});
