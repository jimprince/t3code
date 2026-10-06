import {
  parseDecisionContext,
  type DecisionContextImage,
} from "@t3tools/client-runtime/decision-context";
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { useMemo, useState } from "react";
import { Image } from "expo-image";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState } from "../../state/assets";

const COLLAPSED_LINES = 3;

/** One embedded picture, through the server's Gitea credential when it is a Gitea upload. */
function ContextImage({
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
  const uri = state._tag === "Success" ? state.url : state._tag === "Failure" ? image.url : null;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={image.alt || "Open picture full size"}
      disabled={uri === null}
      onPress={() => uri && void tryOpenExternalUrl(uri, "markdown-link")}
    >
      {uri ? (
        <Image
          source={{ uri }}
          style={{ width: 96, height: 64, borderRadius: 6 }}
          contentFit="cover"
          accessibilityLabel={image.alt || "Picture"}
        />
      ) : (
        <View className="h-16 w-24 rounded-md border border-border" />
      )}
    </Pressable>
  );
}

/**
 * A decision's context on a mobile card: links open in the browser, pictures show as
 * thumbnails that open full size, and long context folds to a few lines with More.
 */
export function MobileDecisionContext({
  environmentId,
  text,
  issueUrl,
}: {
  readonly environmentId: EnvironmentId;
  readonly text: string;
  readonly issueUrl: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const parsed = useMemo(() => parseDecisionContext(text, issueUrl), [text, issueUrl]);
  return (
    <View className="gap-1.5">
      {parsed.parts.length > 0 ? (
        <Text
          className="text-xs text-foreground-muted"
          numberOfLines={parsed.long && !expanded ? COLLAPSED_LINES : undefined}
        >
          {parsed.parts.map((part, index) =>
            part.kind === "link" ? (
              <Text
                key={index}
                className="text-xs text-foreground underline"
                onPress={() => void tryOpenExternalUrl(part.url, "markdown-link")}
              >
                {part.text}
              </Text>
            ) : (
              part.text
            ),
          )}
        </Text>
      ) : null}
      {parsed.images.length > 0 ? (
        <View className="flex-row flex-wrap gap-1.5">
          {parsed.images.map((image) => (
            <ContextImage key={image.url} environmentId={environmentId} image={image} />
          ))}
        </View>
      ) : null}
      {parsed.long ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded((current) => !current)}
          className="min-h-11 justify-center self-start"
        >
          <Text className="text-xs text-foreground-muted">{expanded ? "Less" : "More"}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
