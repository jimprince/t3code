import { useAtomValue } from "@effect/atom-react";
import { createHarnessQuery } from "@t3tools/client-runtime/state/harness-query";
import type { EnvironmentId, HarnessSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { environmentServerConfigsAtom } from "./server";

const harnessQuery = createHarnessQuery(connectionAtomRuntime);
const snapshotInput = { historyLimit: 10 } as const;

export interface HarnessEnvironmentView {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The last answer, kept while a refresh is pending or has failed so rows never vanish on a blip. */
  readonly snapshot: HarnessSnapshot | null;
  readonly error: string | null;
}

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

/**
 * Every connected environment that serves `harness.snapshot`, each with its own answer. Read only
 * while a mounted Harness list subscribes, so the Threads and Projects modes poll nothing.
 */
const harnessEnvironmentsAtom = Atom.make((get): readonly HarnessEnvironmentView[] => {
  const configs = get(environmentServerConfigsAtom);
  const views: HarnessEnvironmentView[] = [];
  for (const [environmentId, presentation] of get(environmentPresentations.presentationsAtom)) {
    if (configs.get(environmentId)?.environment.capabilities.harness !== true) continue;
    const result = get(harnessQuery({ environmentId, input: snapshotInput }));
    views.push({
      environmentId,
      label: presentation.entry.target.label,
      snapshot: Option.getOrNull(AsyncResult.value(result)),
      error: result._tag === "Failure" ? formatError(result.cause) : null,
    });
  }
  return views;
}).pipe(Atom.withLabel("mobile-harness:environments"));

/** Forces a read now. Its identity never changes, so a focus effect can hold it without looping. */
function refreshHarness() {
  for (const { environmentId } of appAtomRegistry.get(harnessEnvironmentsAtom)) {
    appAtomRegistry.refresh(harnessQuery({ environmentId, input: snapshotInput }));
  }
}

export function useHarnessEnvironments() {
  return { environments: useAtomValue(harnessEnvironmentsAtom), refresh: refreshHarness };
}
