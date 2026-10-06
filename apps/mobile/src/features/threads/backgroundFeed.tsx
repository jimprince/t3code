import { useSupervisionForest } from "../../state/forkSupervision";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  supervisionForest,
  supervisionThreadKey,
} from "@t3tools/client-runtime/state/fork-nesting";
import { useThreadShells } from "../../state/entities";
import { foldMobileBackgroundFeed } from "./backgroundFeed.logic";
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
      foldMobileBackgroundFeed({
        ...input,
        workerIds,
        expanded,
        allTraffic,
        labelForThread: (id) => shells.find((t) => t.id === id)?.title,
      }),
    [input.feed, input.liveRunId, workerIds, expanded, allTraffic, shells],
  );
  const control = result.traffic.hasBackgroundTraffic ? (
    <View>
      <Pressable onPress={() => setAllTraffic((v) => !v)} accessibilityRole="button">
        <Text className="text-foreground text-xs">{allTraffic ? "Brad view" : "All traffic"}</Text>
      </Pressable>
      {!allTraffic
        ? result.traffic.runs.map((run) => (
            <Pressable
              key={run.id}
              accessibilityRole="button"
              onPress={() =>
                setExpanded((keys) => {
                  const next = new Set(keys);
                  if (next.has(run.id)) next.delete(run.id);
                  else next.add(run.id);
                  return next;
                })
              }
            >
              <Text className="text-foreground text-xs">
                {run.turnCount} worker turns · {run.lastLine}
              </Text>
            </Pressable>
          ))
        : null}
    </View>
  ) : null;
  return { ...result, control };
}
