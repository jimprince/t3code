import {
  DEFAULT_SERVER_SETTINGS,
  EmbeddedPages,
  type ServerSettings,
  resolveEmbeddedPages,
} from "@t3tools/contracts";
import { splitSharedServerPatch } from "@t3tools/client-runtime/state/shared-settings";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { findEmbeddedPage, moveEmbeddedPage, resolveEmbeddedPageHost } from "./embeddedPages.logic";

const decodeEmbeddedPages = Schema.decodeUnknownSync(EmbeddedPages);

it("round-trips shared page edits through V2 settings while an empty primary suppresses remote pages", () => {
  const pages = [
    { id: "local", name: "LAN", url: "http://status.home", icon: "future-icon" },
    { id: "remote", name: "Remote", url: "https://example.test", icon: "globe" },
  ];
  const write = (settings: ServerSettings, embeddedPages: typeof pages) => {
    const { sharedPatch, localPatch } = splitSharedServerPatch({ embeddedPages });
    expect(localPatch).toEqual({});
    // Persisted settings are decoded through the actual contract on restart.
    const saved = applyServerSettingsPatch(settings, sharedPatch);
    return {
      ...saved,
      embeddedPages: decodeEmbeddedPages(
        JSON.parse(JSON.stringify(saved.embeddedPages)),
      ),
    };
  };
  const created = write(DEFAULT_SERVER_SETTINGS, pages);
  const reordered = write(created, [...moveEmbeddedPage(created.embeddedPages, 1, -1)]);
  expect(resolveEmbeddedPages(reordered, [created]).map((page) => page.id)).toEqual([
    "remote",
    "local",
  ]);
  expect(findEmbeddedPage(reordered.embeddedPages, "local")?.icon).toBe("future-icon");
  expect(
    resolveEmbeddedPageHost(pages[0]!.url, { desktopWebview: true, appProtocol: "t3code:" }).kind,
  ).toBe("webview");
  expect(
    resolveEmbeddedPageHost(pages[0]!.url, { desktopWebview: false, appProtocol: "https:" }).kind,
  ).toBe("blocked");
  const removed = write(reordered, []);
  expect(resolveEmbeddedPages(removed, [created])).toEqual([]);
  expect(findEmbeddedPage(removed.embeddedPages, "local")).toBeNull();
});
