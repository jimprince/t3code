import { describe, expect, it } from "vite-plus/test";

import { resolveTimelineIsAtEnd, stepTimelineEndRestore } from "./MessagesTimeline.logic";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";

// Mirrors what the timeline saves on each scroll event: the measured end state
// plus whether live follow is still on.
function saveScroll(
  key: string,
  geometry: { contentLength: number; scroll: number; scrollLength: number },
  liveFollowEnabled: boolean,
) {
  rememberTimelinePosition(
    key,
    {
      rowId: "assistant-12",
      offsetWithinRow: 24,
      scrollOffset: geometry.scroll,
      atEnd: resolveTimelineIsAtEnd(geometry) === true,
    },
    liveFollowEnabled,
  );
}

describe("remembered follow state while rows grow", () => {
  it("keeps a following thread at its end when a row outgrows the viewport before the follow scroll", () => {
    const key = "follow-growth:thread";
    const viewport = { scrollLength: 700 };
    saveScroll(key, { ...viewport, contentLength: 2000, scroll: 1300 }, true);
    expect(readTimelinePosition(key)?.atEnd).toBe(true);

    // A tool row grows by 260 px; the smooth follow scroll has not caught up.
    const grown = { ...viewport, contentLength: 2260, scroll: 1300 };
    expect(resolveTimelineIsAtEnd(grown)).toBe(false);
    saveScroll(key, grown, true);
    expect(readTimelinePosition(key)?.atEnd).toBe(true);
  });

  it("remembers the reading position once the reader has left the follow", () => {
    const key = "follow-growth:reader";
    saveScroll(key, { scrollLength: 700, contentLength: 2260, scroll: 1560 }, true);

    // A wheel-up turns follow off, then the same growth leaves a real gap.
    saveScroll(key, { scrollLength: 700, contentLength: 2400, scroll: 900 }, false);
    expect(readTimelinePosition(key)).toEqual({
      rowId: "assistant-12",
      offsetWithinRow: 24,
      scrollOffset: 900,
      atEnd: false,
    });
  });
});

describe("end restore after a thread switch", () => {
  const viewport = { scrollLength: 748 };

  // Runs the per-frame step over a sequence of list states, the way the
  // timeline does after its scroll to the end resolves.
  function runFrames(frames: ReadonlyArray<{ contentLength: number; scroll: number }>) {
    let stableFrames = 0;
    const actions: string[] = [];
    for (const [frame, state] of frames.entries()) {
      const step = stepTimelineEndRestore({ ...viewport, ...state }, stableFrames, frame);
      stableFrames = step.stableFrames;
      actions.push(step.action);
      if (step.action === "settled") break;
    }
    return actions;
  }

  it("starts over when a late measurement pushes the end away between settled frames", () => {
    expect(
      runFrames([
        { contentLength: 5_000, scroll: 4_252 },
        { contentLength: 5_900, scroll: 4_252 },
        { contentLength: 5_900, scroll: 5_152 },
        { contentLength: 5_900, scroll: 5_152 },
      ]),
    ).toEqual(["wait", "scroll-to-end", "wait", "settled"]);
  });

  it("gives up on a view that never reaches the end, so follow takes over", () => {
    const actions = runFrames(
      Array.from({ length: 100 }, () => ({ contentLength: 10_000, scroll: 0 })),
    );
    expect(actions.at(-1)).toBe("settled");
    expect(actions.slice(0, -1).every((action) => action === "scroll-to-end")).toBe(true);
    expect(actions.length).toBeLessThan(100);
  });
});
