import { useAtomValue } from "@effect/atom-react";
import { createHarnessQuery } from "@t3tools/client-runtime/state/harness-query";
import type { EnvironmentId, HarnessSnapshot } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";
import { formatEnvironmentQueryError } from "./query";

const harnessQuery = createHarnessQuery(connectionAtomRuntime);
/** Run history shown per check; the server bounds it, and the details panel lists what it gets. */
const HISTORY_LIMIT = 10;
const snapshotInput = { historyLimit: HISTORY_LIMIT } as const;

export interface HarnessEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The last answer, kept while a refresh is pending or has failed so rows never vanish on a blip. */
  readonly snapshot: HarnessSnapshot | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/**
 * Every connected environment that serves `harness.snapshot`, each with its own answer: a host
 * running an older server is left out, one that fails shows its error without hiding the others.
 * Atoms are read only while a mounted view subscribes, so a hidden tab polls nothing.
 */
const harnessEnvironmentsAtom = Atom.make((get): readonly HarnessEnvironmentView[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const configs = get(environmentServerConfigsAtom);
  const views: HarnessEnvironmentView[] = [];
  for (const [environmentId, presentation] of presentations) {
    if (configs.get(environmentId)?.environment.capabilities.harness !== true) continue;
    const result = get(harnessQuery({ environmentId, input: snapshotInput }));
    views.push({
      environmentId,
      label: presentation.entry.target.label,
      snapshot: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatEnvironmentQueryError(result.cause) : null,
      isPending: result.waiting,
    });
  }
  return views;
}).pipe(Atom.withLabel("web-harness:environments"));

/** Forces a read now. Its identity never changes, so effects can hold it without re-subscribing. */
function refreshHarness() {
  for (const { environmentId } of appAtomRegistry.get(harnessEnvironmentsAtom)) {
    appAtomRegistry.refresh(harnessQuery({ environmentId, input: snapshotInput }));
  }
}

/**
 * Harness data for the visible tab: polled by the query's own interval while mounted, refetched
 * when the window regains focus, and not read at all once the tab unmounts.
 */
export function useHarnessEnvironments() {
  const environments = useAtomValue(harnessEnvironmentsAtom);
  useEffect(() => {
    window.addEventListener("focus", refreshHarness);
    return () => window.removeEventListener("focus", refreshHarness);
  }, []);
  return { environments, refresh: refreshHarness };
}
