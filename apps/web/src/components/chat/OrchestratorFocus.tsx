import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  deriveBackgroundTraffic,
  collectDescendantThreadIds,
  stabilizeBackgroundTraffic,
  type BackgroundTraffic,
  type BackgroundTurnMessage,
} from "@t3tools/client-runtime/background-turns";
import type { EnvironmentId, OrchestrationThreadActivity, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { type ReactNode, useMemo, useRef } from "react";

import { environmentThreadShells } from "../../state/threads";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const KEY_SEPARATOR = "\u0000";
const EMPTY_TRAFFIC: BackgroundTraffic = {
  runs: [],
  attentionCount: 0,
  hasBackgroundTraffic: false,
};

/**
 * Descendants of one thread as "id\ttitle" lines. A string keeps the subscriber
 * from re-rendering when unrelated shells in the environment change.
 */
const workerThreadsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split(KEY_SEPARATOR) as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const descendants = collectDescendantThreadIds(threadId, threads);
    return threads
      .filter((thread) => descendants.has(thread.id))
      .map((thread) => `${thread.id}\t${thread.title}`)
      .join("\n");
  });
});

/** Threads showing all traffic this session. Brad view is the default everywhere. */
const allTrafficAtom = Atom.family((_threadKey: string) => Atom.make(false).pipe(Atom.keepAlive));

const ATTENTION_ACTIVITY_KINDS = new Set(["approval.requested", "user-input.requested"]);

/** Brad view state for the open thread: its background runs and the All traffic switch. */
export function useOrchestratorFocus(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly messages: ReadonlyArray<BackgroundTurnMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly liveTurnId: string | null;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? `${input.environmentId}${KEY_SEPARATOR}${input.threadId}`
      : `none${KEY_SEPARATOR}none`;
  const workerLines = useAtomValue(workerThreadsAtom(threadKey));
  const allTraffic = useAtomValue(allTrafficAtom(threadKey));
  const setAllTraffic = useAtomSet(allTrafficAtom(threadKey));

  const workers = useMemo(() => {
    const titles = new Map<string, string>();
    for (const line of workerLines.length > 0 ? workerLines.split("\n") : []) {
      const [id, title] = line.split("\t");
      titles.set(id!, title ?? "");
    }
    return titles;
  }, [workerLines]);
  const attentionTurnKey = input.activities
    .filter((activity) => ATTENTION_ACTIVITY_KINDS.has(activity.kind) && activity.turnId)
    .map((activity) => activity.turnId)
    .join("\n");

  const previousRef = useRef<BackgroundTraffic | null>(null);
  const traffic = useMemo(() => {
    if (input.threadId === null) return EMPTY_TRAFFIC;
    const next = deriveBackgroundTraffic({
      messages: input.messages,
      workerThreadIds: new Set(workers.keys()),
      attentionTurnIds: new Set(attentionTurnKey.length > 0 ? attentionTurnKey.split("\n") : []),
      liveTurnId: input.liveTurnId,
      labelForThread: (threadId) => workers.get(threadId) || undefined,
    });
    return stabilizeBackgroundTraffic(previousRef.current, next);
  }, [input.threadId, input.messages, input.liveTurnId, workers, attentionTurnKey]);
  previousRef.current = traffic;

  return { traffic, allTraffic, setAllTraffic };
}

/** Brad view / All traffic switch and the needs-you count, above the timeline. */
export function OrchestratorFocusBar(props: {
  readonly traffic: BackgroundTraffic;
  readonly allTraffic: boolean;
  readonly onAllTrafficChange: (allTraffic: boolean) => void;
  readonly children?: ReactNode;
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
      <div className="ms-auto flex items-center gap-2">{props.children}</div>
    </div>
  );
}
