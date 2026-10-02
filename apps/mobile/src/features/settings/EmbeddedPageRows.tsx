import { resolveEmbeddedPages } from "@t3tools/contracts";
import * as WebBrowser from "expo-web-browser";
import { useMemo } from "react";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useEnvironments } from "../../state/environments";
import { SettingsRow } from "./components/SettingsRow";

/**
 * The sidebar footer pages configured on the desktop and web clients, listed in
 * Settings → App. Each opens in the in-app browser, which is a top-level page,
 * so http pages and login cookies behave as they would in Safari or Chrome.
 */
export function EmbeddedPageRows() {
  const { environments } = useEnvironments();
  const pages = useMemo(
    () =>
      resolveEmbeddedPages(
        null,
        environments.map((environment) => environment.serverConfig?.settings ?? null),
      ),
    [environments],
  );
  return pages.map((page) => (
    <SettingsRow
      key={page.id}
      icon="globe"
      label={page.name}
      onPress={() => {
        void WebBrowser.openBrowserAsync(page.url).catch(() =>
          tryOpenExternalUrl(page.url, "markdown-link"),
        );
      }}
    />
  ));
}
