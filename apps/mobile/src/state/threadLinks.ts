import { environmentShell } from "./shell";
import { environmentThreadShells } from "./threads";
import { workspaceConnections } from "./workspace";
import { appAtomRegistry } from "./atom-registry";
import {
  createThreadLinkAtoms,
  threadLinkKey,
  threadLinkTarget,
} from "@t3tools/client-runtime/state/thread-link-resolution";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

const threadLinkAtom = createThreadLinkAtoms({
  environmentsAtom: workspaceConnections.environmentsAtom,
  threadIndexAtom: environmentThreadShells.environmentThreadIndexAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

/**
 * The thread a `t3-thread://v1/<id>` link in a message of `environmentId` opens: that
 * environment's thread first, then any other connected environment's.
 */
export function resolveThreadLinkTarget(environmentId: EnvironmentId, threadId: ThreadId) {
  return threadLinkTarget(
    appAtomRegistry.get(threadLinkAtom(threadLinkKey(environmentId, threadId))),
    {
      environmentId,
      threadId,
    },
  );
}
