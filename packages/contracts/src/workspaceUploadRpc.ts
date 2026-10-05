import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ProjectUploadFileInput,
  ProjectUploadFileResult,
  ProjectUploadFileError,
} from "./project.ts";
export const WorkspaceUploadMethods = { projectsUploadFile: "projects.uploadFile" } as const;
export const WorkspaceUploadRpc = Rpc.make(WorkspaceUploadMethods.projectsUploadFile, {
  payload: ProjectUploadFileInput,
  success: ProjectUploadFileResult,
  error: Schema.Union([ProjectUploadFileError, EnvironmentAuthorizationError]),
});
