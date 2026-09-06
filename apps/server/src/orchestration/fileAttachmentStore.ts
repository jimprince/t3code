// @effect-diagnostics nodeBuiltinImport:off
/**
 * fileAttachmentStore - tmp-dir store for chat file attachments.
 *
 * Non-image files dropped on the chat composer are decoded here and written
 * under the OS tmp dir; the thread receives the absolute path (see
 * fileAttachmentPrompt.ts) instead of inline bytes. One directory per
 * attachment id keeps original file names collision-free.
 *
 * Lifecycle: the OS clears the tmp dir on reboot and a startup sweep removes
 * entries older than FILE_ATTACHMENT_SWEEP_MAX_AGE_MS; thread deletion does
 * not remove tmp files (documented non-goal).
 *
 * @module fileAttachmentStore
 */
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  ChatFileHandoffAttachment,
  ThreadId,
  UploadChatFileAttachment,
} from "@t3tools/contracts";
import {
  CHAT_FILE_ATTACHMENT_MAX_BYTES,
  OrchestrationDispatchCommandError,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { createAttachmentId } from "../attachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";

export const FILE_ATTACHMENTS_TMP_DIR_NAME = "t3-file-attachments";
export const FILE_ATTACHMENT_SWEEP_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function fileAttachmentsTmpRoot(): string {
  return NodePath.join(NodeOS.tmpdir(), FILE_ATTACHMENTS_TMP_DIR_NAME);
}

/**
 * Reduce an uploaded file name to a safe single path segment. Path separators
 * become dashes, control characters are dropped, and pure dot names collapse
 * to the fallback so the result can never traverse.
 */
export function sanitizeFileAttachmentName(name: string): string {
  let sanitized = "";
  for (const char of name.trim()) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) continue;
    sanitized += char === "/" || char === "\\" ? "-" : char;
  }
  if (/^\.+$/.test(sanitized)) sanitized = "";
  sanitized = sanitized.slice(0, 255);
  return sanitized.length === 0 ? "file" : sanitized;
}

/**
 * Decode uploaded file attachments and persist them under the tmp root as
 * `<tmp>/t3-file-attachments/<attachmentId>/<sanitizedName>`.
 */
export const normalizeUploadFileAttachments = Effect.fn("normalizeUploadFileAttachments")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly fileAttachments: ReadonlyArray<UploadChatFileAttachment>;
    /** Test seam; production callers use the os tmp dir default. */
    readonly tmpRoot?: string;
  }) {
    const tmpRoot = input.tmpRoot ?? fileAttachmentsTmpRoot();
    const fileSystem = yield* FileSystem.FileSystem;
    const normalized: Array<ChatFileHandoffAttachment> = [];
    for (const attachment of input.fileAttachments) {
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
      const attachmentId = createAttachmentId(input.threadId);
      if (!attachmentId) {
        return yield* new OrchestrationDispatchCommandError({
          message: "Failed to create a safe attachment id.",
        });
      }
      const fileName = sanitizeFileAttachmentName(attachment.name);
      const attachmentDir = NodePath.join(tmpRoot, attachmentId);
      const absolutePath = NodePath.join(attachmentDir, fileName);
      yield* fileSystem.makeDirectory(attachmentDir, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new OrchestrationDispatchCommandError({
              message: `Failed to create file attachment directory for '${attachment.name}'.`,
            }),
        ),
      );
      yield* fileSystem.writeFile(absolutePath, bytes).pipe(
        Effect.mapError(
          () =>
            new OrchestrationDispatchCommandError({
              message: `Failed to persist file attachment '${attachment.name}'.`,
            }),
        ),
      );
      normalized.push({
        type: "file" as const,
        id: attachmentId,
        name: fileName,
        mimeType: attachment.mimeType.toLowerCase(),
        sizeBytes: bytes.byteLength,
        path: absolutePath,
      });
    }
    return normalized;
  },
);

/**
 * Best-effort removal of tmp attachment directories older than `maxAgeMs`.
 * Runs once at server startup; failures never block boot.
 */
export const sweepStaleFileAttachments = Effect.fn("sweepStaleFileAttachments")(function* (
  maxAgeMs: number = FILE_ATTACHMENT_SWEEP_MAX_AGE_MS,
  tmpRoot?: string,
) {
  const root = tmpRoot ?? fileAttachmentsTmpRoot();
  const cutoff = (yield* Clock.currentTimeMillis) - maxAgeMs;
  // Every filesystem access below handles its own failure, so the promise
  // never rejects and the sweep can never fail server boot.
  const removed = yield* Effect.promise(async () => {
    const removedEntries: Array<string> = [];
    let entries: Array<string>;
    try {
      entries = await NodeFSP.readdir(root);
    } catch {
      return removedEntries;
    }
    for (const entry of entries) {
      const entryPath = NodePath.join(root, entry);
      try {
        const stat = await NodeFSP.stat(entryPath);
        if (stat.mtimeMs < cutoff) {
          await NodeFSP.rm(entryPath, { recursive: true, force: true });
          removedEntries.push(entry);
        }
      } catch {
        // Skip entries that vanish or cannot be inspected.
      }
    }
    return removedEntries;
  });
  if (removed.length > 0) {
    yield* Effect.logInfo("Swept stale file attachments", { removed: removed.length });
  }
  return removed;
});
