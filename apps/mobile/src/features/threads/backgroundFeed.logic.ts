import {
  deriveBackgroundTraffic,
  stabilizeBackgroundTraffic,
  type BackgroundFolds,
  type BackgroundTraffic,
} from "@t3tools/client-runtime/backgroundTurns";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

type BackgroundFoldEntry = Extract<ThreadFeedEntry, { readonly type: "background-fold" }>;

/** Streaming re-derives this on every delta; `previous` keeps unchanged runs referentially equal. */
export function deriveMobileBackgroundTraffic(input: {
  feed: ReadonlyArray<ThreadFeedEntry>;
  workerIds: ReadonlySet<string>;
  liveRunId: string | null;
  previous: BackgroundTraffic | null;
  labelForThread?: (id: string) => string | undefined;
}) {
  const attention = new Set<string>();
  for (const entry of input.feed) {
    if (
      entry.type === "activity-group" &&
      entry.runId &&
      entry.activities.some((a) => a.icon === "alert")
    )
      attention.add(entry.runId);
  }
  return stabilizeBackgroundTraffic(
    input.previous,
    deriveBackgroundTraffic({
      messages: input.feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
      workerThreadIds: input.workerIds,
      liveTurnId: input.liveRunId,
      attentionTurnIds: attention,
      labelForThread: input.labelForThread,
    }),
  );
}

function entryRunId(entry: ThreadFeedEntry): string | null {
  if (entry.type === "message") return entry.message.runId ?? null;
  return "runId" in entry ? entry.runId : null;
}

/** Inserts one fold row per run at its first message and drops collapsed runs' rows. */
export function applyBackgroundFolds<T extends ThreadFeedEntry>(
  feed: ReadonlyArray<T>,
  folds: BackgroundFolds | null,
): ReadonlyArray<T | BackgroundFoldEntry> {
  if (!folds) return feed;
  const next: Array<T | BackgroundFoldEntry> = [];
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
        : folds.hiddenTurnIds.has(entryRunId(entry) ?? "");
    if (!hidden) next.push(entry);
  }
  return next;
}
