import { describe, expect, it } from "vite-plus/test";

import { countActiveDescendantsByThread, resolveThreadDisplayStatus } from "./threadStatus.ts";

const idle = {
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null,
  latestTurn: null,
  backgroundLiveness: null,
} as const;

describe("resolveThreadDisplayStatus", () => {
  it("counts active remote descendants using scoped parent identity", () => {
    const root = { ...idle, id: "root", environmentId: "vm" };
    const decoy = { ...root, environmentId: "laptop" };
    const child = {
      ...idle,
      id: "child",
      environmentId: "laptop",
      remoteParent: { environmentId: "vm", threadId: "root" },
      hasPendingUserInput: true,
    };
    const counts = countActiveDescendantsByThread([root, decoy, child]);
    expect(counts.get("vm:root")).toBe(1);
    expect(counts.get("laptop:root")).toBe(0);
  });
  it("keeps own attention and work ahead of descendant activity", () => {
    expect(
      resolveThreadDisplayStatus({
        ...idle,
        hasPendingApprovals: true,
        session: { status: "running" },
        hasActiveDescendants: true,
      }),
    ).toBe("approval");
    expect(
      resolveThreadDisplayStatus({
        ...idle,
        hasPendingUserInput: true,
        session: { status: "running" },
        hasActiveDescendants: true,
      }),
    ).toBe("input");
    expect(
      resolveThreadDisplayStatus({
        ...idle,
        session: { status: "running" },
        hasActiveDescendants: true,
      }),
    ).toBe("working");
  });

  it("shows supervising only for an idle, unsettled thread with active descendants", () => {
    expect(resolveThreadDisplayStatus({ ...idle, hasActiveDescendants: true })).toBe("supervising");
    expect(resolveThreadDisplayStatus({ ...idle, hasActiveDescendants: true, settled: true })).toBe(
      "ready",
    );
    expect(resolveThreadDisplayStatus(idle)).toBe("ready");
  });

  it("keeps failures and own background work ahead of supervising", () => {
    expect(
      resolveThreadDisplayStatus({
        ...idle,
        session: { status: "error" },
        hasActiveDescendants: true,
      }),
    ).toBe("failed");
    expect(
      resolveThreadDisplayStatus({
        ...idle,
        backgroundLiveness: "monitoring",
        hasActiveDescendants: true,
      }),
    ).toBe("monitoring");
  });
});

describe("countActiveDescendantsByThread", () => {
  it("rolls running and input activity through every nesting depth", () => {
    const threads = [
      { ...idle, environmentId: "env", id: "root", parentThreadId: null },
      { ...idle, environmentId: "env", id: "child", parentThreadId: "root" },
      {
        ...idle,
        environmentId: "env",
        id: "working-grandchild",
        parentThreadId: "child",
        session: { status: "running" },
      },
      {
        ...idle,
        environmentId: "env",
        id: "input-grandchild",
        parentThreadId: "child",
        hasPendingUserInput: true,
      },
    ];

    const counts = countActiveDescendantsByThread(threads);
    expect(counts.get("env:root")).toBe(2);
    expect(counts.get("env:child")).toBe(2);
  });

  it("excludes settled descendants and terminates malformed cycles", () => {
    const threads = [
      {
        ...idle,
        environmentId: "env",
        id: "a",
        parentThreadId: "b",
        session: { status: "running" },
      },
      {
        ...idle,
        environmentId: "env",
        id: "b",
        parentThreadId: "a",
        hasPendingUserInput: true,
        settledOverride: "settled" as const,
      },
    ];

    const counts = countActiveDescendantsByThread(threads);
    expect(counts.get("env:a")).toBe(1);
    expect(counts.get("env:b")).toBe(1);
  });
});
