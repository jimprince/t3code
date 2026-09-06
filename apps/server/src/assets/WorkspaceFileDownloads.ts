import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";

export const WorkspaceFileDownloadClaims = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("workspace-file-download"),
  workspaceRoot: Schema.String,
  relativePath: Schema.String,
  downloadName: Schema.String,
  expiresAt: Schema.Number,
});

/** Signed downloads name one canonical workspace file, never a sibling asset. */
export function workspaceFileDownloadClaims(
  workspaceRoot: string,
  relativePath: string,
  downloadName: string,
  expiresAt: number,
) {
  return {
    version: 1 as const,
    kind: "workspace-file-download" as const,
    workspaceRoot,
    relativePath,
    downloadName,
    expiresAt,
  };
}

export function resolveWorkspaceFileDownload<E, R>(
  claims: typeof WorkspaceFileDownloadClaims.Type,
  decodedPath: string,
  resolveFile: (input: {
    workspaceRoot: string;
    relativePath: string;
  }) => Effect.Effect<string | null, E, R>,
) {
  if (decodedPath !== claims.downloadName) return Effect.succeed(null);
  return resolveFile({
    workspaceRoot: claims.workspaceRoot,
    relativePath: claims.relativePath,
  }).pipe(
    Effect.map((file) =>
      file
        ? { kind: "file" as const, path: file, download: true, fileName: claims.downloadName }
        : null,
    ),
  );
}
