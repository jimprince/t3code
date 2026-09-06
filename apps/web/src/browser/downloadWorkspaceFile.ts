import { useCallback } from "react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { toastManager } from "~/components/ui/toast";
import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import { resolveAssetUrl } from "~/assets/assetUrls";

export interface WorkspaceFileLinkPolicy {
  readonly downloadAvailable: boolean;
  readonly defaultAction: "open" | "download";
}

export function workspaceFileLinkPolicy(
  connected: boolean,
  targetTag: string | undefined,
): WorkspaceFileLinkPolicy {
  return {
    downloadAvailable: connected,
    defaultAction: connected && targetTag !== "PrimaryConnectionTarget" ? "download" : "open",
  };
}

export async function createWorkspaceFileDownloadUrl<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, E>>;
}): Promise<AtomCommandResult<string, E>> {
  const result = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: "workspace-file-download",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  return mapAtomCommandResult(result, (asset) => {
    const url = resolveAssetUrl(input.httpBaseUrl, asset.relativeUrl);
    if (url === null) {
      throw new Error("The environment returned an invalid download URL.");
    }
    return url;
  });
}

export function startBrowserDownload(url: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

export function useWorkspaceFileDownloadAction(
  onDownload: (() => Promise<AtomCommandResult<string, unknown>>) | undefined,
  targetPath: string,
) {
  return useCallback(() => {
    if (!onDownload) return;
    void onDownload().then(
      (result) => {
        if (result._tag === "Success") {
          startBrowserDownload(result.value);
          return;
        }
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to download file",
          description: error instanceof Error ? error.message : targetPath,
        });
      },
      (cause) =>
        toastManager.add({
          type: "error",
          title: "Unable to download file",
          description: cause instanceof Error ? cause.message : targetPath,
        }),
    );
  }, [onDownload, targetPath]);
}
