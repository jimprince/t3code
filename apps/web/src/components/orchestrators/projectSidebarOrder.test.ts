import { describe, expect, it } from "vite-plus/test";

import { reconcileProjectSidebarBuckets } from "./projectSidebarOrder";

describe("reconcileProjectSidebarBuckets", () => {
  it("debounces promotion but applies demotion immediately", () => {
    const initial = reconcileProjectSidebarBuckets(new Map(), new Map([["project", "idle"]]), 0);
    const pending = reconcileProjectSidebarBuckets(
      initial.state,
      new Map([["project", "needs-you"]]),
      1_000,
    );
    expect(pending.state.get("project")).toMatchObject({
      displayed: "idle",
      pending: "needs-you",
    });
    const promoted = reconcileProjectSidebarBuckets(
      pending.state,
      new Map([["project", "needs-you"]]),
      31_000,
    );
    expect(promoted.state.get("project")?.displayed).toBe("needs-you");
    const demoted = reconcileProjectSidebarBuckets(
      promoted.state,
      new Map([["project", "quiet"]]),
      31_001,
    );
    expect(demoted.state.get("project")).toEqual({
      displayed: "quiet",
      pending: null,
      pendingSince: null,
    });
  });

  it("cancels a pending promotion when the row returns to its displayed bucket", () => {
    const idle = new Map([
      ["project", { displayed: "idle", pending: null, pendingSince: null }],
    ] as const);
    const pending = reconcileProjectSidebarBuckets(idle, new Map([["project", "working"]]), 1_000);
    const cancelled = reconcileProjectSidebarBuckets(
      pending.state,
      new Map([["project", "idle"]]),
      2_000,
    );
    expect(cancelled.state.get("project")).toEqual({
      displayed: "idle",
      pending: null,
      pendingSince: null,
    });
  });
});
