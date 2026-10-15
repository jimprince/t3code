import { useAtomValue } from "@effect/atom-react";
import {
  createThreadLinkAtoms,
  threadLinkKey,
  threadLinkTarget,
  type ThreadLinkResolution,
} from "@t3tools/client-runtime/state/thread-link-resolution";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentSummaries } from "./presentation";
import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";

const threadLinkAtom = createThreadLinkAtoms({
  environmentsAtom: environmentSummaries.environmentsAtom,
  threadIndexAtom: environmentThreadShells.environmentThreadIndexAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

/**
 * Where a `t3-thread://v1/<id>` link in a message of `messageEnvironmentId` leads: that
 * environment first, then any other connected one.
 */
export function useThreadLink(
  messageEnvironmentId: EnvironmentId,
  threadId: ThreadId,
): ThreadLinkResolution<OrchestrationV2ThreadShell> {
  return useAtomValue(threadLinkAtom(threadLinkKey(messageEnvironmentId, threadId)));
}

/**
 * The thread a bare thread id from a project's data opens, for a click handler that cannot use the
 * hook: the project's environment first, then any other connected one. A thread that lives on
 * another machine opens there, never under the project's environment.
 */
export function resolveThreadLinkTarget(environmentId: EnvironmentId, threadId: ThreadId) {
  return threadLinkTarget(
    appAtomRegistry.get(threadLinkAtom(threadLinkKey(environmentId, threadId))),
    { environmentId, threadId },
  );
}
