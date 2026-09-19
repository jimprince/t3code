import { useMemo } from "react";
import type {
  ChatFileAttachment,
  EnvironmentId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { MODEL_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";

import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { startBrowserDownload } from "~/browser/downloadWorkspaceFile";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { FileSurfaceLoading } from "../files/fileSurfaceChrome";
import { ModelPreview } from "./ModelPreview";

function useWorkspaceModelAsset(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
  readonly mutationId?: string | null;
  readonly downloadName?: string;
}) {
  const resource = useMemo(
    () => ({ _tag: "workspace-file" as const, threadId: input.threadId, path: input.path }),
    [input.path, input.threadId],
  );
  const downloadResource = useMemo(
    () => ({ ...resource, _tag: "workspace-file-download" as const }),
    [resource],
  );
  const assetUrl = useAssetUrlState(input.environmentId, resource);
  const refresh = useAssetUrlRefresh(input.environmentId, resource);
  const prepareDownload = useAssetUrlRefresh(input.environmentId, downloadResource);
  useWorkspaceMutationRefresh({
    mutationId: input.mutationId ?? null,
    resourceKey: JSON.stringify([input.environmentId, resource]),
    refresh: () => void refresh().catch(() => undefined),
  });
  const download = () => {
    void prepareDownload().then((url) => {
      if (!url) return;
      if (input.downloadName === undefined) {
        startBrowserDownload(url);
      } else {
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = input.downloadName;
        anchor.click();
      }
    });
  };
  return { assetUrl, refresh, download };
}

export function WorkspaceModelPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const { assetUrl, refresh, download } = useWorkspaceModelAsset({
    environmentId: props.environmentId,
    threadId: props.threadRef.threadId,
    path: props.absolutePath,
    mutationId: props.workspaceMutationId,
    downloadName: props.name,
  });
  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs">
        <p className="text-destructive">Unable to preview this 3D model.</p>
        <div className="flex gap-2">
          <button type="button" className="underline" onClick={() => void refresh()}>
            Try again
          </button>
          <button type="button" className="underline" onClick={download}>
            Download file
          </button>
        </div>
      </div>
    );
  }
  if (assetUrl._tag !== "Success") return <FileSurfaceLoading />;
  return (
    <ModelPreview
      url={assetUrl.url}
      name={props.name}
      className="min-h-0 flex-1"
      onRetry={refresh}
      onDownload={download}
    />
  );
}

export function ChatMarkdownAssetModel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly path: string;
  readonly name: string;
}) {
  const { assetUrl, refresh, download } = useWorkspaceModelAsset({
    environmentId: props.threadRef.environmentId,
    threadId: props.threadRef.threadId,
    path: props.path,
  });
  if (assetUrl._tag === "Failure") {
    return (
      <div className="my-2 flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg bg-black text-xs text-white/75">
        <button type="button" className="underline" onClick={() => void refresh()}>
          Model unavailable. Retry
        </button>
        <button type="button" className="underline" onClick={download}>
          Download file
        </button>
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="my-2 flex min-h-56 items-center justify-center rounded-lg bg-black text-xs text-white/75">
        Loading 3D model…
      </div>
    );
  }
  return (
    <ModelPreview
      url={assetUrl.url}
      name={props.name}
      className="my-2 h-80 w-full rounded-lg border border-border/80"
      onRetry={refresh}
      onDownload={download}
    />
  );
}

export function AttachmentModelPreview({
  file,
  environmentId,
  onDownload,
}: {
  readonly file: ChatFileAttachment;
  readonly environmentId: EnvironmentId;
  readonly onDownload: () => void;
}) {
  const modelTooLarge = file.sizeBytes > MODEL_PREVIEW_MAX_BYTES;
  const resource = useMemo(
    () =>
      modelTooLarge
        ? null
        : {
            _tag: "attachment" as const,
            attachmentId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            disposition: "inline" as const,
          },
    [file.id, file.mimeType, file.name, modelTooLarge],
  );
  const assetUrl = useAssetUrlState(environmentId, resource);
  const refresh = useAssetUrlRefresh(environmentId, resource);
  if (modelTooLarge) {
    return (
      <ModelPreview
        url=""
        name={file.name}
        sizeBytes={file.sizeBytes}
        className="h-72 rounded-lg border border-border/80"
        onDownload={onDownload}
      />
    );
  }
  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-56 flex-col items-center justify-center gap-2 rounded-lg bg-black px-4 text-center text-xs text-white/75">
        <button type="button" className="underline" onClick={() => void refresh()}>
          Model unavailable. Retry
        </button>
        <button type="button" className="underline" onClick={onDownload}>
          Download file
        </button>
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-56 items-center justify-center rounded-lg bg-black text-xs text-white/75">
        Loading 3D model…
      </div>
    );
  }
  return (
    <ModelPreview
      url={assetUrl.url}
      name={file.name}
      sizeBytes={file.sizeBytes}
      className="h-72 rounded-lg border border-border/80"
      onRetry={refresh}
      onDownload={onDownload}
    />
  );
}
