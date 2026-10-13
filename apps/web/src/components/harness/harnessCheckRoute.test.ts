import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

/** The Harness check route's path, the same pattern routes/_chat.harness.checks.* declares. */
function createCheckRouter(initialEntry = "/") {
  const root = createRootRoute();
  const check = createRoute({
    getParentRoute: () => root,
    path: "harness/checks/$environmentId/$checkKey",
  });
  return createRouter({
    routeTree: root.addChildren([check]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
}

describe("Harness check route", () => {
  it("round-trips a snapshot key with colons, percent escapes and URL-significant characters", async () => {
    const keys = [
      "env:automation:15c7fd6f-088b-48a2-8c7d-1be461e243b9",
      "env:thread:delegated-task:command%3Amcp%3Aabc%3Adelegate-task",
      "env:scheduled-task:name with spaces/and?query=1#hash",
    ];
    for (const checkKey of keys) {
      const router = createCheckRouter();
      await router.navigate({
        to: "/harness/checks/$environmentId/$checkKey",
        params: { environmentId: "env", checkKey },
      });
      // A shared link is the pathname alone: loading it again must give the same key back.
      const shared = router.state.location.href;
      const reopened = createCheckRouter(shared);
      await reopened.load();
      expect(reopened.state.matches.at(-1)?.params).toEqual({ environmentId: "env", checkKey });
    }
  });
});
