import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
} from "@t3tools/client-runtime/backgroundTurns";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Mobile keeps the native feed types; folds carry the original entries for reversal. */
export function foldMobileBackgroundFeed(input: {
  feed: ReadonlyArray<ThreadFeedEntry>;
  workerIds: ReadonlySet<string>;
  liveRunId: string | null;
  expanded: ReadonlySet<string>;
  allTraffic: boolean;
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
  const traffic = deriveBackgroundTraffic({
    messages: input.feed.flatMap((entry) => (entry.type === "message" ? [entry.message] : [])),
    workerThreadIds: input.workerIds,
    liveTurnId: input.liveRunId,
    attentionTurnIds: attention,
    labelForThread: input.labelForThread,
  });
  const folds = resolveBackgroundFolds(traffic.runs, input.expanded);
  return {
    traffic,
    feed: input.allTraffic
      ? input.feed
      : input.feed.filter((entry) =>
          entry.type === "message"
            ? !folds.hiddenMessageIds.has(entry.message.id)
            : !("runId" in entry && entry.runId && folds.hiddenTurnIds.has(entry.runId)),
        ),
  };
}
