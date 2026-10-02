import { useAtomValue } from "@effect/atom-react";
import {
  collectDescendantThreadIds,
  deriveBackgroundTraffic,
  stabilizeBackgroundTraffic,
  type BackgroundRun,
  type BackgroundTraffic,
} from "@t3tools/client-runtime/background-turns";
import type { EnvironmentId, OrchestrationThreadShell } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useMemo, useRef } from "react";

import { deriveUnsettledTurnId } from "../../lib/threadActivity";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { environmentThreadShells } from "../../state/threads";

const KEY_SEPARATOR = "\u0000";
const EMPTY_RUNS: ReadonlyArray<BackgroundRun> = [];
const ATTENTION_ACTIVITY_KINDS = new Set(["approval.requested", "user-input.requested"]);

/** Descendants of one thread as "id\ttitle" lines, so unrelated shell changes do not re-render. */
const workerThreadsAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split(KEY_SEPARATOR) as [EnvironmentId, string];
  return Atom.make((get) => {
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const descendants = collectDescendantThreadIds(threadId, threads);
    return threads
      .filter((thread) => descendants.has(thread.id))
      .map((thread) => `${thread.id}\t${thread.title}`)
      .join("\n");
  });
});

/** Brad view runs for the open thread. Mobile folds by default; each run expands on tap. */
export function useBackgroundRuns(
  environmentId: EnvironmentId,
  thread: OrchestrationThreadShell,
): ReadonlyArray<BackgroundRun> {
  const detail = useSelectedThreadDetail();
  const workerLines = useAtomValue(
    workerThreadsAtom(`${environmentId}${KEY_SEPARATOR}${thread.id}`),
  );
  const workers = useMemo(() => {
    const titles = new Map<string, string>();
    for (const line of workerLines.length > 0 ? workerLines.split("\n") : []) {
      const [id, title] = line.split("\t");
      titles.set(id!, title ?? "");
    }
    return titles;
  }, [workerLines]);
  const activities = detail?.id === thread.id ? detail.activities : undefined;
  const attentionTurnKey = (activities ?? [])
    .filter((activity) => ATTENTION_ACTIVITY_KINDS.has(activity.kind) && activity.turnId)
    .map((activity) => activity.turnId)
    .join("\n");
  const messages = detail?.id === thread.id ? detail.messages : undefined;
  const liveTurnId =
    (thread.session?.status === "running" ? thread.session.activeTurnId : null) ??
    deriveUnsettledTurnId(thread.latestTurn);

  const previousRef = useRef<BackgroundTraffic | null>(null);
  const traffic = useMemo(() => {
    if (!messages) return null;
    return stabilizeBackgroundTraffic(
      previousRef.current,
      deriveBackgroundTraffic({
        messages,
        workerThreadIds: new Set(workers.keys()),
        attentionTurnIds: new Set(attentionTurnKey.length > 0 ? attentionTurnKey.split("\n") : []),
        liveTurnId,
        labelForThread: (threadId) => workers.get(threadId) || undefined,
      }),
    );
  }, [messages, workers, attentionTurnKey, liveTurnId]);
  previousRef.current = traffic;
  return traffic?.runs ?? EMPTY_RUNS;
}
