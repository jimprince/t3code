import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  supervisionRoots,
  supervisionForest,
  supervisionIsActive,
  supervisionVisiblePaths,
} from "./forkNesting.ts";

const env = EnvironmentId.make("local");
function thread(id: string, parentThreadId: string | null = null) {
  return presentThreadShell(env, {
    ...v2ThreadShell,
    id: ThreadId.make(id),
    parentThreadId,
  } as typeof v2ThreadShell);
}

describe("V2 organizational supervision", () => {
  it("keeps all depths and pinned/open ancestor paths, without exposing execution lineage as nesting", () => {
    const root = thread("root"),
      child = thread("child", "root"),
      leaf = { ...thread("leaf", "child"), pinnedAt: "2026-10-05T00:00:00Z" };
    const forest = supervisionForest([root, child, leaf]);
    expect([...forest.parentByKey]).toEqual([
      ["local:child", "local:root"],
      ["local:leaf", "local:child"],
    ]);
    expect([...supervisionVisiblePaths(forest, null)]).toEqual([
      "local:leaf",
      "local:child",
      "local:root",
    ]);
    expect(
      supervisionVisiblePaths(supervisionForest([root, child]), "local:child").has("local:root"),
    ).toBe(true);
    expect(
      supervisionForest([
        { ...child, source: { ...child.source, parentThreadId: undefined } as typeof child.source },
      ]).parentByKey.size,
    ).toBe(0);
  });
  it("makes missing parents and cycles reachable roots", () => {
    expect(
      supervisionForest([thread("a", "b"), thread("b", "a"), thread("orphan", "missing")])
        .parentByKey.size,
    ).toBe(0);
  });
  it("uses stopped V2 runtime rather than a stale latest run", () => {
    const t = thread("worker");
    expect(
      supervisionIsActive({
        ...t,
        runtime: t.runtime ? { ...t.runtime, status: "interrupted" } : null,
      }),
    ).toBe(false);
    expect(supervisionIsActive({ ...t, hasPendingUserInput: true })).toBe(true);
    expect(
      supervisionIsActive({ ...t, hasPendingUserInput: true, settledOverride: "settled" }),
    ).toBe(false);
  });
  it("counts each active descendant once", () => {
    const root = thread("root"),
      child = thread("child", "root"),
      leaf = { ...thread("leaf", "child"), hasPendingApprovals: true, settledOverride: null };
    expect(supervisionForest([root, child, leaf]).activeCounts.get("local:root")).toBe(
      Number(supervisionIsActive(child)) + 1,
    );
  });
});

it("keeps the cross-project parent reachable when only its child matches a scope", () => {
  const parent = thread("parent"),
    child = thread("child", "parent");
  expect(supervisionRoots([child], supervisionForest([parent, child])).map((t) => t.id)).toEqual([
    "parent",
  ]);
});
