import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("electron", () => ({ app: {} }));
import { buildDesktopThreadNavigationUrl, parseDesktopThreadDeepLink } from "./DesktopDeepLink.ts";
import { isSameOriginRendererNavigation } from "../window/DesktopWindow.ts";
import { resolveForkDesktopIdentity } from "./ForkDesktopIdentity.ts";

const environmentId = "c9d5fd19-15d1-45f1-856d-3d05a939854d";
const threadId = "058233fa-53c0-4058-93ae-0c883d8f654b";

describe("V2 thread navigation and identity", () => {
  it.each([false, true])(
    "uses the canonical environment-scoped route (development=%s)",
    (development) => {
      const target = parseDesktopThreadDeepLink(`t3code://threads/${environmentId}/${threadId}`)!;
      const url = buildDesktopThreadNavigationUrl(target, development);
      expect(new URL(url).pathname).toBe(`/${environmentId}/${threadId}`);
      expect(
        isSameOriginRendererNavigation({
          applicationUrl: development ? "t3code-dev://app/" : "t3code://app/",
          navigationUrl: url,
        }),
      ).toBe(true);
      expect(
        isSameOriginRendererNavigation({
          applicationUrl: "t3code://app/",
          navigationUrl: "https://attacker.invalid/",
        }),
      ).toBe(false);
    },
  );
  it("keeps stable, packaged dev, and source dev credentials and import sources distinct", () => {
    const identities = [
      resolveForkDesktopIdentity("stable"),
      resolveForkDesktopIdentity("dev"),
      resolveForkDesktopIdentity("stable", true),
    ];
    expect(new Set(identities.map((x) => x.current)).size).toBe(3);
    for (const identity of identities) {
      expect(identity.v1Profiles).not.toContain("t3code");
      expect(identity.v1Profiles).not.toContain("T3 Code (Alpha)");
      expect(identity.current).toContain("fork");
    }
  });
});
