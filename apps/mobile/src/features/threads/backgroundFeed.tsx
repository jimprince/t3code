import { useCallback, useMemo, useRef, useState } from "react";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import {
  resolveBackgroundFolds,
  type BackgroundTraffic,
} from "@t3tools/client-runtime/backgroundTurns";
import { useSupervisionForest } from "../../state/forkSupervision";
import { deriveMobileBackgroundTraffic } from "./backgroundFeed.logic";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Worker traffic folds to one row per run; a row expands on press. */
export function useMobileBackgroundFeed(input: {
  feed: ReadonlyArray<ThreadFeedEntry>;
  rootKey: string;
  liveRunId: string | null;
}) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const forest = useSupervisionForest();
  // "id\ttitle" lines: a string keeps unrelated shell churn from re-deriving traffic.
  const workerLines = useMemo(() => {
    const lines: string[] = [];
    const pending = [input.rootKey];
    while (pending.length) {
      for (const child of forest.children.get(pending.pop()!) ?? []) {
        lines.push(`${child.id}\t${child.title}`);
        pending.push(supervisionThreadKey(child));
      }
    }
    return lines.join("\n");
  }, [forest, input.rootKey]);
  const workers = useMemo(() => {
    const titles = new Map<string, string>();
    for (const line of workerLines.length > 0 ? workerLines.split("\n") : []) {
      const [id, title] = line.split("\t");
      titles.set(id!, title ?? "");
    }
    return titles;
  }, [workerLines]);
  const previousRef = useRef<BackgroundTraffic | null>(null);
  const traffic = useMemo(
    () =>
      deriveMobileBackgroundTraffic({
        feed: input.feed,
        liveRunId: input.liveRunId,
        workerIds: new Set(workers.keys()),
        previous: previousRef.current,
        labelForThread: (id) => workers.get(id) || undefined,
      }),
    [input.feed, input.liveRunId, workers],
  );
  previousRef.current = traffic;
  const folds = useMemo(
    () => (traffic.runs.length > 0 ? resolveBackgroundFolds(traffic.runs, expanded) : null),
    [traffic, expanded],
  );
  const toggleFold = useCallback((runId: string) => {
    setExpanded((keys) => {
      const next = new Set(keys);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
  return { folds, toggleFold };
}
