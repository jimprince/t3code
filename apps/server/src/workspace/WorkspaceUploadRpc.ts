import { ProjectUploadFileError, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as WorkspaceUploads from "./WorkspaceUploads.ts";
export const makeWorkspaceUploadHandlers = Effect.gen(function* () {
  const uploads = yield* WorkspaceUploads.WorkspaceUploads;
  return {
    [WS_METHODS.projectsUploadFile]: (input: Parameters<typeof uploads.uploadFile>[0]) =>
      uploads.uploadFile(input).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectUploadFileError({
              cwd: input.cwd,
              relativePath: input.fileName,
              failure:
                cause._tag === "WorkspacePathOutsideRootError"
                  ? "workspace_path_outside_root"
                  : cause._tag === "WorkspaceFilePathEscapeError"
                    ? "resolved_path_outside_root"
                    : "operation_failed",
              cause,
            }),
        ),
      ),
  };
});
