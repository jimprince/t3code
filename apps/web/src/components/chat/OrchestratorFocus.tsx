import { useSupervisionForest } from "../../state/forkSupervision";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useMemo, useState } from "react";
import { useThreadShells, useThreadProjection } from "../../state/entities";
import {
  supervisionForest,
  supervisionThreadKey,
} from "@t3tools/client-runtime/state/fork-nesting";
import {
  deriveBackgroundTraffic,
  resolveBackgroundFolds,
} from "@t3tools/client-runtime/backgroundTurns";
import type { TimelineEntry } from "../../session-logic";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export function foldBackgroundRows(
  rows: ReadonlyArray<MessagesTimelineRow>,
  folds: ReturnType<typeof resolveBackgroundFolds>,
  toggle: (id: string) => void,
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
          onToggle: () => toggle(run.id),
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

export function BackgroundFoldRow(
  props: Extract<MessagesTimelineRow, { kind: "background-fold" }>,
) {
  return (
    <button type="button" className="w-full py-2 text-left text-xs" onClick={props.onToggle}>
      {props.run.turnCount} worker turns · {props.run.senderLabels.join(", ")}
      {props.run.lastLine ? ` · ${props.run.lastLine}` : ""}
    </button>
  );
}

/** Only descendants of this environment-scoped organizational root can fold. */
export function useOrchestratorFocus(input: {
  threadKey: string;
  entries: ReadonlyArray<TimelineEntry>;
  rows: ReadonlyArray<MessagesTimelineRow>;
  liveRunId: string | null;
}) {
  const shells = useThreadShells();
  const projection = useThreadProjection(parseScopedThreadKey(input.threadKey))?.projection;
  const forest = useSupervisionForest();
  const [allTraffic, setAllTraffic] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const traffic = useMemo(() => {
    const descendants = new Set<string>();
    const pending = [input.threadKey];
    while (pending.length) {
      for (const child of forest.children.get(pending.pop()!) ?? []) {
        const key = supervisionThreadKey(child);
        descendants.add(child.id);
        pending.push(key);
      }
    }
    const attention = new Set<string>();
    for (const request of projection?.runtimeRequests ?? []) {
      if (request.status === "pending") {
        const node = projection?.nodes.find((node) => node.id === request.nodeId);
        if (node?.runId) attention.add(node.runId);
      }
    }
    for (const run of projection?.runs ?? []) {
      if (run.status === "failed" || run.status === "interrupted") attention.add(run.id);
    }
    for (const entry of input.entries) {
      if (entry.kind === "proposed-plan" && entry.proposedPlan.runId)
        attention.add(entry.proposedPlan.runId);
      if (
        entry.kind === "work" &&
        entry.entry.runId &&
        (entry.entry.toolLifecycleStatus === "inProgress" ||
          entry.entry.itemType === "approval_request" ||
          entry.entry.itemType === "user_input_request")
      )
        attention.add(entry.entry.runId);
    }
    return deriveBackgroundTraffic({
      messages: input.entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : [])),
      workerThreadIds: descendants,
      attentionTurnIds: attention,
      liveTurnId: input.liveRunId,
      labelForThread: (id) => shells.find((t) => t.id === id)?.title,
    });
  }, [forest, input.entries, input.liveRunId, input.threadKey, shells, projection]);
  const toggle = (id: string) =>
    setExpanded((keys) => {
      const next = new Set(keys);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const rows = useMemo(
    () =>
      allTraffic
        ? [...input.rows]
        : foldBackgroundRows(input.rows, resolveBackgroundFolds(traffic.runs, expanded), toggle),
    [allTraffic, input.rows, traffic, expanded],
  );
  const control = traffic.hasBackgroundTraffic ? (
    <button
      type="button"
      aria-pressed={allTraffic}
      onClick={() => setAllTraffic((value) => !value)}
    >
      {allTraffic ? "Brad view" : "All traffic"}
      {traffic.attentionCount > 0 ? ` · ${traffic.attentionCount} need attention` : ""}
    </button>
  ) : null;
  return { rows, control };
}
