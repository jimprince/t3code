import { linkifyText } from "@t3tools/client-runtime/linkify";
import { useMemo } from "react";

import { AppText as Text } from "../../components/AppText";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

/**
 * Nested runs for a Text: http(s) URLs become links that open in the system browser. Inside a
 * pressable option the link takes its own press, and the rest of the text still selects.
 */
export function MobileLinkifiedText({ text }: { readonly text: string }) {
  const parts = useMemo(() => linkifyText(text), [text]);
  return parts.map((part, index) =>
    part.kind === "link" ? (
      <Text
        key={index}
        accessibilityRole="link"
        className="text-foreground underline"
        onPress={() => void tryOpenExternalUrl(part.url, "markdown-link")}
      >
        {part.text}
      </Text>
    ) : (
      part.text
    ),
  );
}
