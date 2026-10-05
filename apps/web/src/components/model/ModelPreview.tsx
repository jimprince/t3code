import { MODEL_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { DownloadIcon } from "lucide-react";
import { lazy, Suspense } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const ModelViewer = lazy(() => import("./ModelViewer"));

export function ModelPreview(props: {
  readonly url: string;
  readonly name: string;
  readonly sizeBytes?: number;
  readonly className?: string;
  readonly onDownload?: () => void;
  readonly onRetry?: () => Promise<unknown>;
}) {
  if (props.sizeBytes !== undefined && props.sizeBytes > MODEL_PREVIEW_MAX_BYTES) {
    return (
      <div
        className={cn(
          "flex min-h-56 flex-col items-center justify-center gap-3 bg-black px-6 text-center text-xs text-white/75",
          props.className,
        )}
      >
        <p>This model is larger than the 50 MB preview limit.</p>
        {props.onDownload ? (
          <Button
            size="sm"
            variant="secondary"
            aria-label={`Download ${props.name}`}
            onClick={props.onDownload}
          >
            <DownloadIcon />
            Download file
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <div className="flex min-h-56 items-center justify-center bg-black text-xs text-white/75">
          Loading 3D viewer…
        </div>
      }
    >
      <ModelViewer {...props} />
    </Suspense>
  );
}
