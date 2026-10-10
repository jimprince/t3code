import { describe, expect, it } from "vite-plus/test";

import { planProjectMove, type ProjectMoveRow } from "./projectSidebarMove.logic";

const pinned = (key: string, pinOrderKey: string | null): ProjectMoveRow => ({
  key,
  pinned: true,
  pinOrderKey,
});
const auto = (key: string): ProjectMoveRow => ({ key, pinned: false, pinOrderKey: null });

/** Applies the writes and re-sorts like the sidebar: pinned by key, then the rest as they were. */
function settle(rows: ReadonlyArray<ProjectMoveRow>, plan: ReturnType<typeof planProjectMove>) {
  const written = new Map(plan.writes.map((write) => [write.key, write.orderKey]));
  const next = rows.map((row) =>
    written.has(row.key) ? { ...row, pinned: true, pinOrderKey: written.get(row.key)! } : row,
  );
  const run = next
    .filter((row) => row.pinned)
    .sort((left, right) => left.pinOrderKey!.localeCompare(right.pinOrderKey!));
  return [...run, ...next.filter((row) => !row.pinned)].map((row) => row.key);
}

describe("planProjectMove", () => {
  it("moves a pinned project inside the pinned run with one write", () => {
    const rows = [pinned("a", "f"), pinned("b", "m"), pinned("c", "t"), auto("d")];
    const plan = planProjectMove({ rows, movedKey: "c", toIndex: 0 });
    expect(plan.writes).toEqual([{ kind: "reorder", key: "c", orderKey: expect.any(String) }]);
    expect(settle(rows, plan)).toEqual(["c", "a", "b", "d"]);
  });

  it("pins an unpinned project dropped into the pinned run", () => {
    const rows = [pinned("a", "f"), pinned("b", "m"), auto("c"), auto("d")];
    const plan = planProjectMove({ rows, movedKey: "d", toIndex: 1 });
    expect(plan.writes).toEqual([{ kind: "pin", key: "d", orderKey: expect.any(String) }]);
    expect(settle(rows, plan)).toEqual(["a", "d", "b", "c"]);
  });

  it("pins every project above a drop below the pinned run so the list reads as dropped", () => {
    const rows = [auto("a"), auto("b"), auto("c"), auto("d")];
    const plan = planProjectMove({ rows, movedKey: "d", toIndex: 2 });
    expect(plan.writes.map((write) => [write.kind, write.key]).sort()).toEqual([
      ["pin", "a"],
      ["pin", "b"],
      ["pin", "d"],
    ]);
    expect(settle(rows, plan)).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps pinned projects below a moved-down project in the run", () => {
    const rows = [pinned("a", "f"), pinned("b", "m"), auto("c"), auto("d")];
    const plan = planProjectMove({ rows, movedKey: "a", toIndex: 2 });
    expect(settle(rows, plan)).toEqual(["b", "c", "a", "d"]);
  });

  it("never reuses a reserved key from a hidden pinned project", () => {
    const rows = [auto("a"), auto("b")];
    const plan = planProjectMove({ rows, movedKey: "b", toIndex: 0, reservedKeys: ["n"] });
    expect(plan.writes.map((write) => write.orderKey)).not.toContain("n");
    expect(settle(rows, plan)).toEqual(["b", "a"]);
  });

  it("writes nothing for a drop in place or an unknown project", () => {
    const rows = [pinned("a", "f"), auto("b")];
    expect(planProjectMove({ rows, movedKey: "a", toIndex: 0 }).writes).toEqual([]);
    expect(planProjectMove({ rows, movedKey: "x", toIndex: 0 }).writes).toEqual([]);
  });
});
