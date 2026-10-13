export interface ResultTimelineRow {
  position: number;
  sourceThreadId: string;
  sourceItemId: string;
  item: {
    type: string;
    id: string;
    messageId?: string;
    text?: string;
    [key: string]: unknown;
  };
}

export interface ResultTimelinePage {
  totalItems: number;
  items: ResultTimelineRow[];
  humanMessageIds: string[];
}

export const RESULT_SCAN_BUDGET = 1000;
const PAGE_SIZE = 100;

/** Read backward in canonical position blocks without loading full projections. */
export async function readResultTimeline(input: {
  count: number;
  humanOnly?: boolean;
  assistantOnly?: boolean;
  readPage: (afterPosition: number, limit: number) => Promise<ResultTimelinePage>;
  scanBudget?: number;
}) {
  const budget = input.scanBudget ?? RESULT_SCAN_BUDGET;
  if (!Number.isSafeInteger(input.count) || input.count < 1 || input.count > budget) {
    throw new Error(`--tail must be an integer from 1 to ${budget}.`);
  }
  const probe = await input.readPage(-1, 0);
  let end = probe.totalItems;
  let scanned = 0;
  let selected: ResultTimelineRow[] = [];
  while (end > 0 && selected.length < input.count && scanned < budget) {
    const limit = Math.min(
      PAGE_SIZE,
      budget - scanned,
      end,
      input.humanOnly || input.assistantOnly ? PAGE_SIZE : input.count - selected.length,
    );
    const start = end - limit;
    const page = await input.readPage(start - 1, limit);
    if (
      page.items.length !== limit ||
      page.items[0]?.position !== start ||
      page.items.at(-1)?.position !== end - 1 ||
      page.totalItems < end
    ) {
      throw new Error("Server returned a noncanonical result page.");
    }
    const humanIds = new Set(page.humanMessageIds);
    const matching = page.items.filter((row) =>
      input.humanOnly
        ? row.item.type === "user_message" &&
          row.item.messageId !== undefined &&
          humanIds.has(row.item.messageId)
        : input.assistantOnly
          ? row.item.type === "assistant_message"
          : true,
    );
    selected = [...matching, ...selected].slice(-input.count);
    scanned += limit;
    end = start;
  }
  return {
    items: selected,
    scanned,
    scanBudget: budget,
    scanBudgetExhausted: selected.length < input.count && end > 0,
  };
}
