import { describe, expect, it } from "vite-plus/test";
import { arrayMove, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { orderItemsByPreferredIds, planThreadBlockDrop } from "./Sidebar.logic";

// Modelled row geometry exercises the production drop planner against
// dnd-kit's real sorting strategy. This verifies preview/commit ordering,
// not browser layout, paint invalidation, or post-drop compositing.

interface SimRow {
  readonly key: string;
  /** What the row occupies on screen right now. */
  readonly height: number;
  readonly reorderable: boolean;
}

interface SimRect {
  readonly key: string;
  readonly top: number;
  readonly height: number;
}

function stack(rows: readonly SimRow[], pick: (row: SimRow) => number): SimRect[] {
  let top = 0;
  return rows.map((row) => {
    const rect = { key: row.key, top, height: pick(row) };
    top += rect.height;
    return rect;
  });
}

/** closestCenter over the droppables dnd-kit knows about — which is exactly
    the rows registered in the SortableContext. */
function closestCenter(rects: readonly SimRect[], draggedCenterY: number): string | null {
  let closest: string | null = null;
  let closestDistance = Number.POSITIVE_INFINITY;
  for (const rect of rects) {
    const distance = Math.abs(rect.top + rect.height / 2 - draggedCenterY);
    if (distance < closestDistance) {
      closestDistance = distance;
      closest = rect.key;
    }
  }
  return closest;
}

/**
 * One frame of a drag: which row dnd-kit reports as `over`, and the row
 * order the user is looking at while the pointer is held there.
 *
 * `contextKeys` is what the block handed to SortableContext. Rows rendered
 * inside the block but left out of it never move and are never drop
 * targets — the shape this file exists to reject.
 */
function previewDrag(input: {
  readonly rows: readonly SimRow[];
  readonly contextKeys: readonly string[];
  readonly activeKey: string;
  /** How far the pointer has dragged the row from its resting position. */
  readonly pointerDeltaY: number;
}): { readonly overKey: string | null; readonly order: readonly string[] } {
  const { activeKey, contextKeys, pointerDeltaY, rows } = input;
  const renderedByKey = new Map(stack(rows, (row) => row.height).map((rect) => [rect.key, rect]));
  // dnd-kit collides the dragged row's live rect against the rects it
  // measured when the drag began.
  const draggedRendered = renderedByKey.get(activeKey)!;
  const contextRects = contextKeys.map((key) => {
    const rect = renderedByKey.get(key)!;
    return { ...rect, bottom: rect.top + rect.height, left: 0, right: 300, width: 300 };
  });
  const overKey = closestCenter(
    contextRects,
    draggedRendered.top + draggedRendered.height / 2 + pointerDeltaY,
  );
  const activeIndex = contextKeys.indexOf(activeKey);
  const overIndex = overKey === null ? -1 : contextKeys.indexOf(overKey);
  const placed = rows.map((row) => {
    const rendered = renderedByKey.get(row.key)!;
    const index = contextKeys.indexOf(row.key);
    const y =
      index === -1
        ? 0
        : (verticalListSortingStrategy({
            rects: contextRects,
            activeNodeRect: contextRects[activeIndex] ?? null,
            activeIndex,
            overIndex,
            index,
          })?.y ?? 0);
    return { key: row.key, top: rendered.top + y, height: rendered.height };
  });
  return {
    overKey,
    order: [...placed].sort((left, right) => left.top - right.top).map((box) => box.key),
  };
}

// Full card height (4.875rem) plus 2px padding above and below.
const ROW = 82;

function row(key: string, reorderable: boolean, overrides: Partial<SimRow> = {}): SimRow {
  return { key, height: ROW, reorderable, ...overrides };
}

/** How the block renders once the drop is applied optimistically. */
function committedOrder(rows: readonly SimRow[], preferredKeys: readonly string[]): string[] {
  return orderItemsByPreferredIds({
    items: rows,
    preferredIds: preferredKeys,
    getId: (item) => item.key,
  }).map((item) => item.key);
}

describe("planThreadBlockDrop", () => {
  const reorderable = new Set(["a", "b", "c"]);

  it("moves a row exactly the way dnd-kit's arrayMove previews it", () => {
    const renderedKeys = ["a", "b", "c"];
    for (const [from, to] of [
      [0, 2],
      [2, 0],
      [1, 2],
      [2, 1],
    ] as const) {
      const plan = planThreadBlockDrop({
        renderedKeys,
        reorderableKeys: reorderable,
        activeKey: renderedKeys[from]!,
        overKey: renderedKeys[to]!,
      });
      expect(plan?.renderedOrder).toEqual(arrayMove([...renderedKeys], from, to));
      expect(plan?.reorderedKeys).toEqual(arrayMove([...renderedKeys], from, to));
    }
  });

  it("keeps a row that cannot be reordered in the place the drop put it", () => {
    // "legacy" is a row from a server without the reorder capability.
    const plan = planThreadBlockDrop({
      renderedKeys: ["a", "legacy", "b", "c"],
      reorderableKeys: reorderable,
      activeKey: "a",
      overKey: "b",
    });
    expect(plan?.renderedOrder).toEqual(["legacy", "b", "a", "c"]);
    // Only the capable rows get order keys written.
    expect(plan?.reorderedKeys).toEqual(["b", "a", "c"]);
  });

  it("accepts a drop onto a row that cannot itself be reordered", () => {
    const plan = planThreadBlockDrop({
      renderedKeys: ["legacy", "a", "b", "c"],
      reorderableKeys: reorderable,
      activeKey: "b",
      overKey: "legacy",
    });
    expect(plan?.renderedOrder).toEqual(["b", "legacy", "a", "c"]);
    expect(plan?.reorderedKeys).toEqual(["b", "a", "c"]);
  });

  it("reports nothing to do when the capable rows keep their order", () => {
    // Dropping across a single neighbouring legacy row moves no capable row
    // relative to another, so there is no key to write.
    expect(
      planThreadBlockDrop({
        renderedKeys: ["a", "legacy", "b"],
        reorderableKeys: reorderable,
        activeKey: "a",
        overKey: "legacy",
      }),
    ).toBeNull();
    expect(
      planThreadBlockDrop({
        renderedKeys: ["a", "b", "c"],
        reorderableKeys: reorderable,
        activeKey: "a",
        overKey: "a",
      }),
    ).toBeNull();
    expect(
      planThreadBlockDrop({
        renderedKeys: ["a", "b", "c"],
        reorderableKeys: reorderable,
        activeKey: "a",
        overKey: null,
      }),
    ).toBeNull();
    // A row that cannot be reordered cannot be the one being dragged.
    expect(
      planThreadBlockDrop({
        renderedKeys: ["a", "legacy", "b"],
        reorderableKeys: reorderable,
        activeKey: "legacy",
        overKey: "b",
      }),
    ).toBeNull();
  });
});

describe("thread block drag preview matches what the drop commits", () => {
  // a, then a row from a server that cannot reorder, then b and c.
  const rows = [row("a", true), row("legacy", false), row("b", true), row("c", true)];
  const renderedKeys = rows.map((item) => item.key);
  const reorderableKeys = new Set(rows.filter((item) => item.reorderable).map((item) => item.key));
  // Pointer holds "a" over "b"'s resting slot.
  const pointerDeltaY = 2 * ROW;

  it("previews and commits the same order when every rendered row is sortable", () => {
    const preview = previewDrag({ rows, contextKeys: renderedKeys, activeKey: "a", pointerDeltaY });
    const plan = planThreadBlockDrop({
      renderedKeys,
      reorderableKeys,
      activeKey: "a",
      overKey: preview.overKey,
    });
    expect(preview.overKey).toBe("b");
    expect(preview.order).toEqual(["legacy", "b", "a", "c"]);
    expect(plan?.renderedOrder).toEqual(preview.order);
    expect(committedOrder(rows, plan!.renderedOrder)).toEqual(preview.order);
  });

  it("does not, when a rendered row is left out of the sortable context", () => {
    // The pre-fix shape: only capable rows joined SortableContext, and the
    // optimistic order was the capable rows alone.
    const capableKeys = renderedKeys.filter((key) => reorderableKeys.has(key));
    const preview = previewDrag({ rows, contextKeys: capableKeys, activeKey: "a", pointerDeltaY });
    const committed = committedOrder(rows, arrayMove([...capableKeys], 0, 1));

    // Mid-drag the legacy row appears to stay put while "b" slides over it…
    expect(preview.order).toEqual(["b", "legacy", "a", "c"]);
    // …and the drop then renders it somewhere else entirely.
    expect(committed).toEqual(["b", "a", "c", "legacy"]);
    expect(committed).not.toEqual(preview.order);
  });
});

describe("long thread block drags", () => {
  it.each([
    [0, 7],
    [7, 0],
    [2, 11],
    [11, 2],
  ])("previews and commits a move from %i to %i", (from, to) => {
    const rows = Array.from({ length: 12 }, (_, index) => row(`r${index}`, true));
    const keys = rows.map((item) => item.key);
    const preview = previewDrag({
      rows,
      contextKeys: keys,
      activeKey: keys[from]!,
      pointerDeltaY: (to - from) * ROW,
    });
    const plan = planThreadBlockDrop({
      renderedKeys: keys,
      reorderableKeys: new Set(keys),
      activeKey: keys[from]!,
      overKey: preview.overKey,
    });
    expect(preview.overKey).toBe(keys[to]);
    expect(preview.order).toEqual(arrayMove(keys, from, to));
    expect(committedOrder(rows, plan!.renderedOrder)).toEqual(preview.order);
  });
});
