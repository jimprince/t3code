import {
  PROJECT_UPLOAD_FILE_MAX_BYTES,
  type EnvironmentId,
  type ProjectUploadFileInput,
  type ProjectUploadFileResult,
} from "@t3tools/contracts";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

/** Upload one drop to the selected V2 environment. Read failures isolate one file; successful writes invalidate both file data sources through the caller. */
export async function uploadWorkspaceFiles(input: {
  files: readonly File[];
  containsDirectory: boolean;
  environmentId: EnvironmentId;
  cwd: string;
  readFile: (file: File) => Promise<string>;
  uploadFile: (input: {
    environmentId: EnvironmentId;
    input: ProjectUploadFileInput;
  }) => Promise<AtomCommandResult<ProjectUploadFileResult, unknown>>;
  reportFailure: (message: string) => void;
  refresh: () => void;
}) {
  if (input.containsDirectory)
    input.reportFailure("Folders can't be uploaded. Drop individual files instead.");
  const uploaded: string[] = [];
  for (const file of input.files) {
    if (file.size === 0 || file.size > PROJECT_UPLOAD_FILE_MAX_BYTES) {
      input.reportFailure(
        file.size === 0
          ? `'${file.name}' is empty.`
          : `'${file.name}' exceeds the 32 MiB upload limit.`,
      );
      continue;
    }
    try {
      const dataUrl = await input.readFile(file);
      const result = await input.uploadFile({
        environmentId: input.environmentId,
        input: { cwd: input.cwd, fileName: file.name || "upload.bin", dataUrl },
      });
      if (result._tag === "Success") uploaded.push(result.value.relativePath);
    } catch (error) {
      input.reportFailure(
        error instanceof Error ? error.message : `Could not read '${file.name}'.`,
      );
    }
  }
  if (uploaded.length > 0) input.refresh();
  return uploaded;
}
