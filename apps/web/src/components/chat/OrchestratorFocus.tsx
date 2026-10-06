import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useSupervisionWorkerLines } from "../../state/forkSupervision";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useRef, useState } from "react";
import { useThreadProjection } from "../../state/entities";
import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
  stabilizeBackgroundTraffic,
  type BackgroundTraffic,
} from "@t3tools/client-runtime/backgroundTurns";
import type { TimelineEntry } from "../../session-logic";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

/** Threads showing all traffic this session. Brad view is the default everywhere. */
const allTrafficAtom = Atom.family((_threadKey: string) => Atom.make(false).pipe(Atom.keepAlive));

export function foldBackgroundRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  folds: ReturnType<typeof resolveBackgroundFolds>,
): MessagesTimelineRow[] {
  const result: MessagesTimelineRow[] = [];
  for (const row of rows) {
    if (row.kind === "message") {
      const run = folds.runByAnchorMessageId.get(row.message.id);
      if (run)
        result.push({
          kind: "background-fold",
          id: run.id,
          createdAt: run.startedAt,
          run,
          expanded: !folds.hiddenMessageIds.has(run.anchorMessageId),
        });
      if (folds.hiddenMessageIds.has(row.message.id)) continue;
    } else if (row.kind === "assistant-meta" && folds.hiddenMessageIds.has(row.message.id))
      continue;
    else if (
      (row.kind === "work" || row.kind === "work-live") &&
      row.groupedEntries.length > 0 &&
      row.groupedEntries.every(
        (entry) => entry.runId != null && folds.hiddenTurnIds.has(entry.runId),
      )
    )
      continue;
    else if (
      row.kind === "event" &&
      row.projectedItem.item.runId != null &&
      folds.hiddenTurnIds.has(row.projectedItem.item.runId)
    )
      continue;
    else if ("runId" in row && row.runId != null && folds.hiddenTurnIds.has(row.runId)) continue;
    result.push(row);
  }
  return result;
}

/** Brad view / All traffic switch and the needs-you count, above the timeline. */
function OrchestratorFocusBar(props: {
  readonly traffic: BackgroundTraffic;
  readonly allTraffic: boolean;
  readonly onAllTrafficChange: (allTraffic: boolean) => void;
}) {
  if (!props.traffic.hasBackgroundTraffic) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 py-1.5 text-xs">
      <ToggleGroup
        aria-label="Worker traffic"
        variant="segmented"
        value={[props.allTraffic ? "all" : "brad"]}
        onValueChange={(value) => {
          const next = value[0];
          if (next === "all" || next === "brad") props.onAllTrafficChange(next === "all");
        }}
      >
        <Toggle value="brad">Brad view</Toggle>
        <Toggle value="all">All traffic</Toggle>
      </ToggleGroup>
      {props.traffic.attentionCount > 0 ? (
        <span className="text-warning-foreground tabular-nums">
          {props.traffic.attentionCount} for you
        </span>
      ) : null}
    </div>
  );
}

/** Only descendants of this environment-scoped organizational root can fold. */
export function useOrchestratorFocus(input: {
  threadKey: string;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  liveRunId: string | null;
}) {
  const projection = useThreadProjection(parseScopedThreadKey(input.threadKey))?.projection;
  const allTraffic = useAtomValue(allTrafficAtom(input.threadKey));
  const setAllTraffic = useAtomSet(allTrafficAtom(input.threadKey));
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const workerLines = useSupervisionWorkerLines(input.threadKey);
  const workers = useMemo(() => {
    const titles = new Map<string, string>();
    for (const line of workerLines.length > 0 ? workerLines.split("\n") : []) {
      const [id, title] = line.split("\t");
      titles.set(id!, title ?? "");
    }
    return titles;
  }, [workerLines]);
  const previousRef = useRef<BackgroundTraffic | null>(null);
  const traffic = useMemo(() => {
    const attention = new Set<string>();
    const requests = (projection?.runtimeRequests ?? []).filter(
      (request) => request.status === "pending",
    );
    if (requests.length > 0) {
      const runIdByNode = new Map(projection?.nodes.map((node) => [node.id, node.runId]));
      for (const request of requests) {
        const runId = runIdByNode.get(request.nodeId);
        if (runId) attention.add(runId);
      }
    }
    for (const entry of input.entries) {
      if (
        entry.kind === "work" &&
        entry.entry.runId &&
        (entry.entry.itemType === "approval_request" ||
          entry.entry.itemType === "user_input_request")
      )
        attention.add(entry.entry.runId);
    }
    const next = deriveBackgroundTraffic({
      messages: input.entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      workerThreadIds: new Set(workers.keys()),
      attentionTurnIds: attention,
      liveTurnId: input.liveRunId,
      labelForThread: (id) => workers.get(id) || undefined,
    });
    return stabilizeBackgroundTraffic(previousRef.current, next);
  }, [workers, input.entries, input.liveRunId, projection]);
  previousRef.current = traffic;
  const toggleFold = useCallback(
    (id: string) =>
      setExpanded((keys) => {
        const next = new Set(keys);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const rows = useMemo(
    () =>
      allTraffic
        ? [...input.rows]
        : foldBackgroundRows(input.rows, resolveBackgroundFolds(traffic.runs, expanded)),
    [allTraffic, input.rows, traffic, expanded],
  );
  const control = useMemo(
    () => (
      <OrchestratorFocusBar
        traffic={traffic}
        allTraffic={allTraffic}
        onAllTrafficChange={setAllTraffic}
      />
    ),
    [traffic, allTraffic, setAllTraffic],
  );
  return { rows, control, toggleFold };
}
