import { useSupervisionForest } from "../../state/forkSupervision";
import { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import { useThreadShells } from "../../state/entities";
import { deriveMobileBackgroundFolds } from "./backgroundFeed.logic";
import type { ThreadFeedEntry } from "../../lib/threadActivity";

export function useMobileBackgroundFeed(input: {
  feed: ReadonlyArray<ThreadFeedEntry>;
  rootKey: string;
  liveRunId: string | null;
}) {
  const shells = useThreadShells();
  const [allTraffic, setAllTraffic] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const forest = useSupervisionForest();
  const workerIds = useMemo(() => {
    const result = new Set<string>();
    const pending = [input.rootKey];
    while (pending.length) {
      for (const t of forest.children.get(pending.pop()!) ?? []) {
        result.add(t.id);
        pending.push(supervisionThreadKey(t));
      }
    }
    return result;
  }, [forest, input.rootKey]);
  const result = useMemo(
    () =>
      deriveMobileBackgroundFolds({
        feed: input.feed,
        liveRunId: input.liveRunId,
        workerIds,
        expanded,
        labelForThread: (id) => shells.find((t) => t.id === id)?.title,
      }),
    [input.feed, input.liveRunId, workerIds, expanded, shells],
  );
  const toggleFold = useCallback((runId: string) => {
    setExpanded((keys) => {
      const next = new Set(keys);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }, []);
  const control = result.traffic.hasBackgroundTraffic ? (
    <View className="flex-row items-center gap-2 px-2 py-1">
      <Pressable onPress={() => setAllTraffic((v) => !v)} accessibilityRole="button">
        <Text className="text-foreground text-xs">{allTraffic ? "Brad view" : "All traffic"}</Text>
      </Pressable>
      {result.traffic.attentionCount > 0 ? (
        <Text className="text-foreground text-xs">{result.traffic.attentionCount} for you</Text>
      ) : null}
    </View>
  ) : null;
  return { folds: allTraffic ? null : result.folds, control, toggleFold };
}
