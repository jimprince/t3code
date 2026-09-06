// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceUploads - Effect service for binary-capable workspace file uploads.
 *
 * Accepts a base64 data-url payload, writes it as a single path segment in the
 * workspace root, and auto-renames on collision (`name.ext`, `name-1.ext`, …)
 * instead of overwriting. Reuses the WorkspacePaths escape guard and the
 * WorkspaceFileSystem error vocabulary so RPC error mapping stays uniform.
 *
 * @module WorkspaceUploads
 */
import * as NodeFSP from "node:fs/promises";

import type { ProjectUploadFileInput, ProjectUploadFileResult } from "@t3tools/contracts";
import { PROJECT_UPLOAD_FILE_MAX_BYTES } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { parseBase64DataUrl } from "../imageMime.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import {
  WorkspaceFilePathEscapeError,
  WorkspaceFileSystemOperationError,
  type WorkspaceFileSystemError,
} from "./WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

// A bounded probe window keeps a pathological directory from looping forever.
const UPLOAD_RENAME_MAX_ATTEMPTS = 10_000;

export function splitUploadFileName(fileName: string): {
  readonly stem: string;
  readonly ext: string;
} {
  const dotIndex = fileName.lastIndexOf(".");
  // Dotfiles (".env") keep the whole name as the stem so renames become
  // ".env-1", not "-1.env".
  if (dotIndex <= 0) return { stem: fileName, ext: "" };
  return { stem: fileName.slice(0, dotIndex), ext: fileName.slice(dotIndex) };
}

export function isInvalidUploadFileName(fileName: string): boolean {
  if (fileName.length === 0 || fileName === "." || fileName === "..") return true;
  for (const char of fileName) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return fileName.includes("/") || fileName.includes("\\");
}

/** Service tag for workspace upload operations. */
export class WorkspaceUploads extends Context.Service<
  WorkspaceUploads,
  {
    /**
     * Write an uploaded file into the workspace root.
     *
     * The file name must be a single path segment; collisions auto-rename
     * rather than overwrite. Returns the final relative path and size.
     */
    readonly uploadFile: (
      input: ProjectUploadFileInput,
    ) => Effect.Effect<
      ProjectUploadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceUploads") {}

export const make = Effect.gen(function* () {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  const uploadFile: WorkspaceUploads["Service"]["uploadFile"] = Effect.fn(
    "WorkspaceUploads.uploadFile",
  )(function* (input) {
    const fileName = input.fileName.trim();
    if (isInvalidUploadFileName(fileName)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.fileName,
        resolvedWorkspaceRoot: input.cwd,
        resolvedPath: fileName,
      });
    }

    const payloadError = (detail: string) =>
      new WorkspaceFileSystemOperationError({
        workspaceRoot: input.cwd,
        relativePath: fileName,
        resolvedPath: fileName,
        operationPath: fileName,
        operation: "write-file",
        cause: new Error(detail),
      });

    const parsed = parseBase64DataUrl(input.dataUrl);
    if (parsed === null) {
      return yield* payloadError("Upload payload is not a valid base64 data URL.");
    }
    const bytes = Buffer.from(parsed.base64, "base64");
    if (bytes.byteLength === 0) {
      return yield* payloadError("Upload payload is empty.");
    }
    if (bytes.byteLength > PROJECT_UPLOAD_FILE_MAX_BYTES) {
      return yield* payloadError(`Upload payload exceeds ${PROJECT_UPLOAD_FILE_MAX_BYTES} bytes.`);
    }

    const { stem, ext } = splitUploadFileName(fileName);
    for (let attempt = 0; attempt < UPLOAD_RENAME_MAX_ATTEMPTS; attempt++) {
      const candidate = attempt === 0 ? fileName : `${stem}-${attempt}${ext}`;
      const target = yield* workspacePaths.resolveRelativePathWithinRoot({
        workspaceRoot: input.cwd,
        relativePath: candidate,
      });

      // "wx" makes the existence check and the create one atomic operation, so
      // concurrent uploads of the same name cannot overwrite each other.
      const handle = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await NodeFSP.open(target.absolutePath, "wx");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
            throw error;
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: candidate,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "open",
            cause,
          }),
      });
      if (handle === null) continue;

      yield* Effect.tryPromise({
        try: async () => {
          try {
            await handle.writeFile(bytes);
          } finally {
            await handle.close();
          }
        },
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: candidate,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      });

      yield* workspaceEntries.refresh(input.cwd);
      return { relativePath: target.relativePath, sizeBytes: bytes.byteLength };
    }

    return yield* payloadError(
      `Could not find a free file name for '${fileName}' after ${UPLOAD_RENAME_MAX_ATTEMPTS} attempts.`,
    );
  });

  return WorkspaceUploads.of({ uploadFile });
});

export const layer = Layer.effect(WorkspaceUploads, make);
