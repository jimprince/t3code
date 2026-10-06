import { describe, expect, it } from "vite-plus/test";

import {
  planExplicitThreadOrder,
  planThreadMove,
  sortThreadOrderGroup,
  sameThreadOrderGroup,
  threadOrderSection,
  type OrderableThread,
} from "../src/threadOrder.js";

const base = {
  parentThreadId: null,
  pinnedAt: null,
  pinOrderKey: null,
  activeOrderKey: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  unsettledAt: null,
  archivedAt: null,
  settledOverride: null,
} satisfies Omit<OrderableThread, "id">;

function thread(id: string, overrides: Partial<OrderableThread> = {}): OrderableThread {
  return { ...base, id, ...overrides };
}

describe("agent-controlled thread order", () => {
  it("separates remote parents by descriptor even when their thread IDs collide", () => {
    const remote = thread("one", { remoteParent: { environmentId: "a", threadId: "parent" } });
    expect(
      sameThreadOrderGroup(
        remote,
        thread("two", { remoteParent: { environmentId: "a", threadId: "parent" } }),
      ),
    ).toBe(true);
    expect(
      sameThreadOrderGroup(
        remote,
        thread("three", { remoteParent: { environmentId: "b", threadId: "parent" } }),
      ),
    ).toBe(false);
    expect(sameThreadOrderGroup(remote, thread("four"))).toBe(false);
  });
  it("puts listed threads first and retains every unlisted thread's relative order", () => {
    const group = [
      thread("new", { createdAt: "2026-01-04T00:00:00.000Z" }),
      thread("second", { createdAt: "2026-01-03T00:00:00.000Z" }),
      thread("third", { createdAt: "2026-01-02T00:00:00.000Z" }),
      thread("old"),
    ];
    const assignments = planExplicitThreadOrder({ group, leadingIds: ["third", "new"] });
    const keyById = new Map(assignments.map(({ threadId, orderKey }) => [threadId, orderKey]));
    const ordered = sortThreadOrderGroup(
      group.map((item) => ({ ...item, activeOrderKey: keyById.get(item.id) ?? null })),
    );
    expect(ordered.map(({ id }) => id)).toEqual(["third", "new", "second", "old"]);
  });

  it("moves before, after and to either edge within one sibling bucket", () => {
    const group = ["a", "b", "c"].map((id, index) =>
      thread(id, { pinnedAt: base.createdAt, pinOrderKey: ["f", "m", "t"][index] }),
    );
    for (const [input, expected] of [
      [{ threadId: "c", beforeId: "a" }, ["c", "a", "b"]],
      [{ threadId: "a", afterId: "c" }, ["b", "c", "a"]],
      [{ threadId: "c", edge: "top" as const }, ["c", "a", "b"]],
      [{ threadId: "a", edge: "bottom" as const }, ["b", "c", "a"]],
    ] as const) {
      const assignments = planThreadMove({ group, ...input });
      const keys = new Map(assignments.map(({ threadId, orderKey }) => [threadId, orderKey]));
      expect(
        sortThreadOrderGroup(
          group.map((item) => ({ ...item, pinOrderKey: keys.get(item.id) })),
        ).map(({ id }) => id),
      ).toEqual(expected);
    }
  });

  it("keeps pinned and active order distinct and rejects settled rows", () => {
    expect(threadOrderSection(thread("p", { pinnedAt: base.createdAt }))).toBe("pinned");
    expect(threadOrderSection(thread("a"))).toBe("active");
    expect(threadOrderSection(thread("done", { settledOverride: "settled" }))).toBeNull();
  });

  it("rejects duplicates and non-sibling destinations", () => {
    const group = [thread("a"), thread("b")];
    expect(() => planExplicitThreadOrder({ group, leadingIds: ["a", "a"] })).toThrow("duplicates");
    expect(() => planThreadMove({ group, threadId: "a", beforeId: "missing" })).toThrow(
      "not a sibling",
    );
  });
});
