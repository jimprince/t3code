import {
  joinOrchestratorMetadata,
  threadsVisibleInThreadsMode,
  type OrchestratorThreadShell,
} from "@t3tools/client-runtime/state/orchestrators";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import { useMemo } from "react";

import { useThreadShells } from "../../state/entities";
import { useSupervisionMetadata } from "../../state/forkSupervision";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

/** Thread shells joined with the nesting sidecar so organizational parentage and scope are present. */
export function useOrchestratorThreadShells(): ReadonlyArray<OrchestratorThreadShell> {
  const threads = useThreadShells();
  const metadata = useSupervisionMetadata();
  return useMemo(() => joinOrchestratorMetadata(threads, metadata), [metadata, threads]);
}

/** Threads mode keeps standalone roots; shells keep their identity so rows do not re-render. */
export function useThreadsVisibleInThreadsMode(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  projectsViewEnabled: boolean,
): ReadonlyArray<EnvironmentThreadShell> {
  const metadata = useSupervisionMetadata();
  return useMemo(() => {
    if (!projectsViewEnabled) return threads;
    const visible = new Set(
      threadsVisibleInThreadsMode(joinOrchestratorMetadata(threads, metadata), true).map(
        supervisionThreadKey,
      ),
    );
    return threads.filter((thread) => visible.has(supervisionThreadKey(thread)));
  }, [metadata, projectsViewEnabled, threads]);
}
