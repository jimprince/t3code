import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { EmbeddedPage, resolveEmbeddedPages } from "./embeddedPages.ts";
import { DEFAULT_SERVER_SETTINGS, ServerSettings } from "./settings.ts";

const decodeServerSettings = Schema.decodeSync(ServerSettings);

const page = (id: string, url = `https://${id}.example`) => ({
  id,
  name: id,
  url,
  icon: "globe",
});

describe("EmbeddedPage", () => {
  it("accepts http and https URLs only", () => {
    const decode = Schema.decodeUnknownOption(EmbeddedPage);
    expect(decode(page("a", "http://status.home:8770"))._tag).toBe("Some");
    expect(decode(page("a", "https://control.example:8449"))._tag).toBe("Some");
    expect(decode(page("a", "javascript:alert(1)"))._tag).toBe("None");
    expect(decode(page("a", "status.home"))._tag).toBe("None");
  });

  it("keeps an icon this build does not know, so newer settings still decode", () => {
    const settings = decodeServerSettings({
      embeddedPages: [{ ...page("a"), icon: "icon-from-the-future" }],
    });
    expect(settings.embeddedPages[0]?.icon).toBe("icon-from-the-future");
  });
});

describe("resolveEmbeddedPages", () => {
  it("prefers the primary environment, even when its list is empty", () => {
    expect(resolveEmbeddedPages({ embeddedPages: [] }, [{ embeddedPages: [page("a")] }])).toEqual(
      [],
    );
  });

  it("falls back to the first environment with pages when there is no primary", () => {
    expect(
      resolveEmbeddedPages(null, [
        null,
        DEFAULT_SERVER_SETTINGS,
        { embeddedPages: [page("b")] },
        { embeddedPages: [page("c")] },
      ]).map((entry) => entry.id),
    ).toEqual(["b"]);
  });
});
