import type { DecisionContextImage } from "@t3tools/client-runtime/decision-context";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";

/**
 * One embedded picture: fetched through the server, which holds the Gitea token a private
 * repository needs, or directly when it is not a Gitea upload. Opens full size in a new tab.
 */
export function ContextImage({
  environmentId,
  image,
}: {
  readonly environmentId: EnvironmentId;
  readonly image: DecisionContextImage;
}) {
  const resource = useMemo<AssetResource>(
    () => ({ _tag: "gitea-media", url: image.url }),
    [image.url],
  );
  const state = useAssetUrlState(environmentId, resource);
  const src = state._tag === "Success" ? state.url : state._tag === "Failure" ? image.url : null;
  if (src === null) {
    return <span className="block size-16 rounded-md border border-border" />;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noreferrer"
      aria-label={image.alt ? `${image.alt} (open full size)` : "Open picture full size"}
      className="block"
    >
      <img
        src={src}
        alt={image.alt}
        loading="lazy"
        className="h-16 max-w-40 rounded-md border border-border object-cover"
      />
    </a>
  );
}
