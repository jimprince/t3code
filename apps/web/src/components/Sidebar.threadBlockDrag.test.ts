import { describe, expect, it } from "vite-plus/test";
import { arrayMove } from "@dnd-kit/sortable";
import {
  orderItemsByPreferredIds,
  planThreadBlockDrop,
  SIDEBAR_THREAD_ROW_HEIGHT_PX,
  SIDEBAR_THREAD_ROW_IDLE_CLASS,
  SIDEBAR_THREAD_ROW_SORTING_CLASS,
} from "./Sidebar.logic";

// ── A dnd-kit stand-in ─────────────────────────────────────────────────
// The sidebar's draggable blocks (pinned, and the fork's inbox) are plain
// stacks of fixed-height <li> rows driven by closestCenter +
// verticalListSortingStrategy. Both are pure geometry, so they can be run
// here against a modelled stack and used as the oracle for "what did the
// user see mid-drag" — which is the only way to pin the class of bug this
// file guards: a drop that commits somewhere other than where the preview
// opened its slot.
//
// Ported from @dnd-kit/sortable 10.0.0 (getItemGap, verticalListSortingStrategy)
// and @dnd-kit/core (closestCenter). Kept literal on purpose: a paraphrase
// would stop being an oracle.

interface SimRow {
  readonly key: string;
  /** What the row occupies on screen right now. */
  readonly height: number;
  /** What dnd-kit measured when the drag began. Differs from `height` when
      the row was still a content-visibility placeholder at measure time. */
  readonly measuredHeight?: number;
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

function itemGap(rects: readonly SimRect[], index: number, activeIndex: number): number {
  const current = rects[index];
  const previous = rects[index - 1];
  const next = rects[index + 1];
  if (!current) return 0;
  if (activeIndex < index) {
    return previous
      ? current.top - (previous.top + previous.height)
      : next
        ? next.top - (current.top + current.height)
        : 0;
  }
  return next
    ? next.top - (current.top + current.height)
    : previous
      ? current.top - (previous.top + previous.height)
      : 0;
}

function verticalListTransformY(
  rects: readonly SimRect[],
  activeIndex: number,
  overIndex: number,
  index: number,
): number {
  const activeRect = rects[activeIndex];
  if (!activeRect) return 0;
  if (index === activeIndex) {
    const overRect = rects[overIndex];
    if (!overRect) return 0;
    return activeIndex < overIndex
      ? overRect.top + overRect.height - (activeRect.top + activeRect.height)
      : overRect.top - activeRect.top;
  }
  const gap = itemGap(rects, index, activeIndex);
  if (index > activeIndex && index <= overIndex) return -activeRect.height - gap;
  if (index < activeIndex && index >= overIndex) return activeRect.height + gap;
  return 0;
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
  const measuredByKey = new Map(
    stack(rows, (row) => row.measuredHeight ?? row.height).map((rect) => [rect.key, rect]),
  );
  // dnd-kit collides the dragged row's live rect against the rects it
  // measured when the drag began.
  const draggedRendered = renderedByKey.get(activeKey)!;
  const contextRects = contextKeys.map((key) => measuredByKey.get(key)!);
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
      index === -1 ? 0 : verticalListTransformY(contextRects, activeIndex, overIndex, index);
    return { key: row.key, top: rendered.top + y, height: rendered.height };
  });
  return {
    overKey,
    order: [...placed].sort((left, right) => left.top - right.top).map((box) => box.key),
  };
}

const ROW = SIDEBAR_THREAD_ROW_HEIGHT_PX;
/** contain-intrinsic-size on a row that has never painted. Equal to ROW
    after this fix; the stale value shipped 14px taller. */
const STALE_PLACEHOLDER = 96;

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

describe("thread block drag against stale row measurements", () => {
  // A full-height inbox: every row renders at ROW, but only the first two
  // have ever painted. The rest were still content-visibility placeholders
  // when dnd-kit measured the block, so it believes each of them is
  // STALE_PLACEHOLDER tall and every rect below them is too low.
  const keys = Array.from({ length: 12 }, (_, index) => `r${index}`);
  const staleRows = keys.map((key, index) =>
    row(key, true, index < 2 ? {} : { measuredHeight: STALE_PLACEHOLDER }),
  );
  const freshRows = keys.map((key) => row(key, true));
  // Pointer holds the top row over the eighth row's slot.
  const pointerDeltaY = 7 * ROW;

  it("drops on the row the pointer is over when the placeholder height is right", () => {
    const preview = previewDrag({
      rows: freshRows,
      contextKeys: keys,
      activeKey: "r0",
      pointerDeltaY,
    });
    expect(preview.overKey).toBe("r7");
    const plan = planThreadBlockDrop({
      renderedKeys: keys,
      reorderableKeys: new Set(keys),
      activeKey: "r0",
      overKey: preview.overKey,
    });
    expect(plan?.renderedOrder).toEqual(preview.order);
  });

  it("drops on a different row when the placeholder height is wrong", () => {
    const preview = previewDrag({
      rows: staleRows,
      contextKeys: keys,
      activeKey: "r0",
      pointerDeltaY,
    });
    // 14px of drift per never-painted row above the pointer is enough to
    // hand the drop to the row above the one under the cursor.
    expect(preview.overKey).toBe("r6");
    expect(preview.order).not.toEqual(
      previewDrag({ rows: freshRows, contextKeys: keys, activeKey: "r0", pointerDeltaY }).order,
    );
  });
});

describe("sidebar thread row placeholder", () => {
  // The preceding suite shows what a wrong placeholder height costs. These
  // keep the numbers the rows actually ship honest.
  it("claims the same height it renders", () => {
    expect(ROW).toBe(82);
    expect(SIDEBAR_THREAD_ROW_IDLE_CLASS).toContain(`contain-intrinsic-size:auto_${ROW}px`);
  });

  it("stops skipping rows while a drag is in flight", () => {
    expect(SIDEBAR_THREAD_ROW_SORTING_CLASS).toBe("[content-visibility:visible]");
  });
});
