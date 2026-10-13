import { describe, expect, it } from "vite-plus/test";
import { readResultTimeline, type ResultTimelineRow } from "../src/resultTimeline.js";

function timeline(length: number, humans: readonly number[] = []): ResultTimelineRow[] {
  return Array.from({ length }, (_, position) => ({
    position,
    sourceThreadId: "thread",
    sourceItemId: `item-${position}`,
    item: {
      type: humans.length > 0 ? "user_message" : "assistant_message",
      id: `item-${position}`,
      messageId: `message-${position}`,
      text: `${position}`,
    },
  }));
}

function reader(rows: ResultTimelineRow[], humans: readonly number[] = []) {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    readPage: async (afterPosition: number, limit: number) => {
      calls.push([afterPosition, limit]);
      const items = rows.filter((row) => row.position > afterPosition).slice(0, limit);
      return {
        totalItems: rows.length,
        items,
        humanMessageIds: items
          .filter((row) => humans.includes(row.position))
          .map((row) => row.item.messageId!),
      };
    },
  };
}

describe("result timeline paging", () => {
  it("returns exactly the last N canonical items in newest-last order", async () => {
    const source = reader(timeline(250));
    const result = await readResultTimeline({ count: 120, readPage: source.readPage });
    expect(source.calls).toEqual([
      [-1, 0],
      [149, 100],
      [129, 20],
    ]);
    expect(result.items.map((item) => item.position)).toEqual(
      Array.from({ length: 120 }, (_, index) => index + 130),
    );
    expect(result.scanBudgetExhausted).toBe(false);
  });

  it("finds human messages across pages despite more automated notices", async () => {
    const humans = [10, 100, 230];
    const source = reader(timeline(240, humans), humans);
    const result = await readResultTimeline({
      count: 3,
      humanOnly: true,
      readPage: source.readPage,
    });
    expect(result.items.map((item) => item.position)).toEqual(humans);
    expect(result.scanned).toBe(240);
    expect(source.calls).toEqual([
      [-1, 0],
      [139, 100],
      [39, 100],
      [-1, 40],
    ]);
  });

  it("reports exhaustion when the human scan budget ends first", async () => {
    const humans = [10, 100, 230];
    const source = reader(timeline(240, humans), humans);
    const result = await readResultTimeline({
      count: 3,
      humanOnly: true,
      scanBudget: 150,
      readPage: source.readPage,
    });
    expect(result.items.map((item) => item.position)).toEqual([100, 230]);
    expect(result.scanBudgetExhausted).toBe(true);
  });
});
