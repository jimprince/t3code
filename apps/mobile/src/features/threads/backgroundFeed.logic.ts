import type { BackgroundFolds } from "@t3tools/client-runtime/background-turns";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

function entryTurnId(entry: ThreadFeedEntry): string | null {
  if (entry.type === "message") return entry.message.turnId ?? null;
  return "turnId" in entry ? entry.turnId : null;
}

/** Inserts one fold row per run at its first message and drops collapsed runs' rows. */
export function applyBackgroundFolds<T extends ThreadFeedEntry>(
  feed: ReadonlyArray<T>,
  folds: BackgroundFolds | undefined,
): ReadonlyArray<T | Extract<ThreadFeedEntry, { readonly type: "background-fold" }>> {
  if (!folds) return feed;
  const next: Array<T | Extract<ThreadFeedEntry, { readonly type: "background-fold" }>> = [];
  for (const entry of feed) {
    const run = entry.type === "message" ? folds.runByAnchorMessageId.get(entry.message.id) : null;
    if (run) {
      next.push({
        type: "background-fold",
        id: run.id,
        createdAt: run.startedAt,
        run,
        expanded: !folds.hiddenMessageIds.has(run.anchorMessageId),
      });
    }
    const hidden =
      entry.type === "message"
        ? folds.hiddenMessageIds.has(entry.message.id)
        : folds.hiddenTurnIds.has(entryTurnId(entry) ?? "");
    if (!hidden) next.push(entry);
  }
  return next;
}
