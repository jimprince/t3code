import { describe, expect, it } from "vite-plus/test";

import {
  planPinnedMove,
  resolveSettledThreadTimestamp,
  planSidebarMove,
  planSidebarReorder,
  sortPinnedThreadsByOrderKey,
  sortThreads,
  sortThreadsByManualOrderKey,
  type ThreadSortInput,
} from "./threadSort.ts";

type TestThread = { readonly id: string } & ThreadSortInput;

function makeThread(overrides: Partial<TestThread> = {}): TestThread {
  return {
    id: "thread-1",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    messages: [],
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("resolveSettledThreadTimestamp", () => {
  it("prefers the persisted settlement stamp over later activity", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "2026-03-09T10:00:00.000Z",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T10:00:00.000Z");
  });

  it("falls back to the latest activity when the stamp is missing or malformed", () => {
    expect(
      resolveSettledThreadTimestamp({
        settledAt: "invalid",
        latestUserMessageAt: "2026-03-09T11:00:00.000Z",
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T11:00:00.000Z");
    expect(
      resolveSettledThreadTimestamp({
        settledAt: null,
        latestUserMessageAt: null,
        latestTurn: null,
        updatedAt: "2026-03-09T12:00:00.000Z",
      }),
    ).toBe("2026-03-09T12:00:00.000Z");
  });
});

describe("sortThreads", () => {
  it("falls back to updatedAt and createdAt when latestUserMessageAt is invalid and there are no messages", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "not-a-date",
          createdAt: "2026-03-09T10:00:00.000Z",
          updatedAt: "2026-03-09T10:05:00.000Z",
        }),
        makeThread({
          id: "thread-2",
          latestUserMessageAt: "still-not-a-date",
          createdAt: "invalid-created-at",
          updatedAt: "invalid-updated-at",
        }),
        makeThread({
          id: "thread-3",
          latestUserMessageAt: "invalid-latest-user-message-at",
          createdAt: "2026-03-09T10:06:00.000Z",
          updatedAt: "invalid-updated-at",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-3", "thread-1", "thread-2"]);
  });

  it("falls back to the latest valid user message when latestUserMessageAt is invalid", () => {
    const sorted = sortThreads(
      [
        makeThread({
          id: "thread-1",
          latestUserMessageAt: "invalid-latest-user-message-at",
          updatedAt: "2026-03-09T10:00:00.000Z",
          messages: [
            { role: "user", createdAt: "2026-03-09T10:05:00.000Z" },
            { role: "assistant", createdAt: "2026-03-09T10:30:00.000Z" },
            { role: "user", createdAt: "2026-03-09T10:20:00.000Z" },
          ],
        }),
        makeThread({
          id: "thread-2",
          createdAt: "2026-03-09T10:15:00.000Z",
          updatedAt: "2026-03-09T10:15:00.000Z",
        }),
      ],
      "updated_at",
    );

    expect(sorted.map((thread) => thread.id)).toEqual(["thread-1", "thread-2"]);
  });
});

describe("planPinnedMove", () => {
  it("moves a thread up with a single key write", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
      direction: "up",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments![0]!.id).toBe("c");
    expect(assignments![0]!.orderKey > "f" && assignments![0]!.orderKey < "m").toBe(true);
  });

  it("returns null when the move falls off the end of the list", () => {
    const input = {
      orderedIds: ["a", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
      ]),
    };
    expect(planPinnedMove({ ...input, movedId: "a", direction: "up" })).toBeNull();
    expect(planPinnedMove({ ...input, movedId: "b", direction: "down" })).toBeNull();
  });

  it("materializes keys for the whole section when a neighbor is keyless", () => {
    const assignments = planPinnedMove({
      orderedIds: ["a", "b", "c"],
      keysById: new Map([
        ["a", null],
        ["b", "m"],
        ["c", null],
      ]),
      movedId: "b",
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    const keys = assignments!.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });
});

describe("sortPinnedThreadsByOrderKey", () => {
  it("breaks equal keys by id THEN environment so merged lists are stable everywhere", () => {
    const sorted = sortPinnedThreadsByOrderKey([
      {
        id: "thread-1",
        createdAt: "2026-03-09T10:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-b",
      },
      {
        id: "thread-1",
        createdAt: "2026-03-09T11:00:00.000Z",
        pinOrderKey: "m",
        environmentId: "env-a",
      },
    ]);
    expect(sorted.map((thread) => thread.environmentId)).toEqual(["env-a", "env-b"]);
  });
});

// ── Fork: manual inbox order ───────────────────────────────────────────

type InboxThread = {
  readonly id: string;
  readonly sidebarOrderKey?: string | null;
  readonly environmentId?: string;
};

/** Applies a plan to a keys map, mirroring what the server writes. */
function applyPlan(
  keysById: Map<string, string | null>,
  assignments: ReadonlyArray<{ readonly id: string; readonly orderKey: string }>,
): Map<string, string | null> {
  const next = new Map(keysById);
  for (const assignment of assignments) next.set(assignment.id, assignment.orderKey);
  return next;
}

/** Renders the list the way the sidebar does: default order in, manual
    placements hoisted out. */
function renderOrder(
  defaultOrder: readonly string[],
  keysById: ReadonlyMap<string, string | null>,
): string[] {
  return sortThreadsByManualOrderKey(
    defaultOrder.map((id): InboxThread => ({ id, sidebarOrderKey: keysById.get(id) ?? null })),
  ).map((thread) => thread.id);
}

describe("sortThreadsByManualOrderKey", () => {
  it("hoists placed threads above unplaced ones, in key order", () => {
    expect(
      sortThreadsByManualOrderKey<InboxThread>([
        { id: "a" },
        { id: "b", sidebarOrderKey: "t" },
        { id: "c" },
        { id: "d", sidebarOrderKey: "f" },
      ]).map((thread) => thread.id),
    ).toEqual(["d", "b", "a", "c"]);
  });

  it("leaves unplaced threads in the order the default sort gave them", () => {
    expect(
      sortThreadsByManualOrderKey<InboxThread>([{ id: "a" }, { id: "b" }, { id: "c" }]).map(
        (thread) => thread.id,
      ),
    ).toEqual(["a", "b", "c"]);
  });

  it("breaks equal keys by id THEN environment so merged lists are stable everywhere", () => {
    expect(
      sortThreadsByManualOrderKey<InboxThread>([
        { id: "thread-1", sidebarOrderKey: "m", environmentId: "env-b" },
        { id: "thread-1", sidebarOrderKey: "m", environmentId: "env-a" },
      ]).map((thread) => thread.environmentId),
    ).toEqual(["env-a", "env-b"]);
  });
});

describe("planSidebarReorder", () => {
  it("writes a single key when everything above the drop is already placed", () => {
    const assignments = planSidebarReorder({
      orderedIds: ["a", "c", "b"],
      keysById: new Map([
        ["a", "f"],
        ["b", "m"],
        ["c", "t"],
      ]),
      movedId: "c",
    });
    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.id).toBe("c");
    expect(assignments[0]!.orderKey > "f" && assignments[0]!.orderKey < "m").toBe(true);
  });

  it("needs no upper bound when the row below the drop is unplaced", () => {
    const assignments = planSidebarReorder({
      orderedIds: ["a", "c", "b"],
      keysById: new Map<string, string | null>([
        ["a", "f"],
        ["b", null],
        ["c", null],
      ]),
      movedId: "c",
    });
    expect(assignments).toEqual([{ id: "c", orderKey: expect.any(String) }]);
    expect(assignments[0]!.orderKey > "f").toBe(true);
  });

  it("renders the dropped order when a thread is dragged below unplaced rows", () => {
    // Nothing is placed yet: dropping "c" into slot 2 has to materialize the
    // rows above it, or the sort would keep hoisting "c" to the top.
    const defaultOrder = ["a", "b", "c", "d"];
    const keys = new Map<string, string | null>(defaultOrder.map((id) => [id, null]));
    const dropped = ["a", "b", "d", "c"];
    const assignments = planSidebarReorder({
      orderedIds: dropped,
      keysById: keys,
      movedId: "c",
    });
    expect(renderOrder(defaultOrder, applyPlan(keys, assignments))).toEqual(dropped);
  });

  it("keeps a placed row below the drop from sorting back above it", () => {
    // "d" carries an old placement and now belongs BELOW the drop. Respread
    // has to cover it too: leaving "d" on its original key would sort it
    // back to the top of the manual region.
    const defaultOrder = ["a", "b", "c", "d"];
    const keys = new Map<string, string | null>([
      ["a", null],
      ["b", null],
      ["c", null],
      ["d", "f"],
    ]);
    const dropped = ["a", "c", "b", "d"];
    const assignments = planSidebarReorder({
      orderedIds: dropped,
      keysById: keys,
      movedId: "c",
    });
    expect(renderOrder(defaultOrder, applyPlan(keys, assignments))).toEqual(dropped);
  });

  it("leaves threads below the manual region unplaced and free to move", () => {
    const keys = new Map<string, string | null>([
      ["a", null],
      ["b", null],
      ["c", null],
      ["d", null],
    ]);
    const assignments = planSidebarReorder({
      orderedIds: ["b", "a", "c", "d"],
      keysById: keys,
      movedId: "b",
    });
    const written = applyPlan(keys, assignments);
    expect(written.get("b")).not.toBeNull();
    // "b" moved to the top, so only "b" needs a key; "c" and "d" stay in the
    // recency order.
    expect(written.get("c")).toBeNull();
    expect(written.get("d")).toBeNull();
  });

  it("produces assignments in ascending key order", () => {
    const assignments = planSidebarReorder({
      orderedIds: ["a", "b", "c", "d"],
      keysById: new Map<string, string | null>([
        ["a", null],
        ["b", null],
        ["c", null],
        ["d", "f"],
      ]),
      movedId: "a",
    });
    const keys = assignments.map((entry) => entry.orderKey);
    expect([...keys].sort()).toEqual(keys);
  });

  it("returns nothing when the moved thread is not in the list", () => {
    expect(planSidebarReorder({ orderedIds: ["a"], keysById: new Map(), movedId: "zzz" })).toEqual(
      [],
    );
  });
});

describe("planSidebarMove", () => {
  it("swaps a thread with its neighbor and renders the swapped order", () => {
    const defaultOrder = ["a", "b", "c"];
    const keys = new Map<string, string | null>(defaultOrder.map((id) => [id, null]));
    const assignments = planSidebarMove({
      orderedIds: defaultOrder,
      keysById: keys,
      movedId: "c",
      direction: "up",
    });
    expect(assignments).not.toBeNull();
    expect(renderOrder(defaultOrder, applyPlan(keys, assignments!))).toEqual(["a", "c", "b"]);
  });

  it("returns null when the move falls off the end of the list", () => {
    const input = {
      orderedIds: ["a", "b"],
      keysById: new Map<string, string | null>([
        ["a", "f"],
        ["b", "m"],
      ]),
    };
    expect(planSidebarMove({ ...input, movedId: "a", direction: "up" })).toBeNull();
    expect(planSidebarMove({ ...input, movedId: "b", direction: "down" })).toBeNull();
  });
});
