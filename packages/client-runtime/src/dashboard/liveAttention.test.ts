import { describe, expect, it } from "vite-plus/test";

import { liveAttention, liveRuntimeRequests } from "./liveAttention.ts";

const shell = (id: string, pending: string | null, archivedAt: unknown = null) => ({
  id,
  archivedAt,
  pendingRuntimeRequest: pending === null ? null : { id: pending },
});
const ask = (id: string, threadId: string, requestId: string) => ({ id, threadId, requestId });
const issue = { id: "issue", threadId: null, requestId: null };

describe("liveAttention", () => {
  const live = liveRuntimeRequests([
    {
      environmentId: "env",
      threads: [shell("t1", "r1"), shell("t2", null), shell("t3", "r3", "2026-10-15T00:00:00Z")],
    },
    { environmentId: "unloaded", threads: null },
  ]);

  it("keeps a runtime ask only while its thread still has a pending request", () => {
    const kept = liveAttention(
      "env",
      [ask("a", "t1", "r1"), ask("b", "t2", "r2"), ask("d", "t3", "r3")],
      live,
      "live",
    );
    expect(kept.map((item) => item.id)).toEqual(["a"]);
  });

  it("keeps a second pending ask on a thread whose shell lists only one request", () => {
    const kept = liveAttention("env", [ask("a", "t1", "r1"), ask("b", "t1", "r1b")], live, "live");
    expect(kept.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("never lists runtime asks from a stored snapshot, and never touches issue items", () => {
    const all = [issue, ask("a", "t1", "r1")];
    expect(liveAttention("env", all, live, "cached")).toEqual([issue]);
    expect(liveAttention("env", [issue], live, "cached")).toEqual([issue]);
  });

  it("keeps the live snapshot's asks for an environment whose shells have not loaded yet", () => {
    const all = [ask("a", "t1", "r1")];
    expect(liveAttention("unloaded", all, live, "live")).toBe(all);
  });
});
