import { useMemo } from "react";
import { useSupervisionReadyHosts } from "../../../state/forkSupervision";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { environmentServerConfigsAtom } from "../../../state/server";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../../connection/runtime";
export { newForkCommandId } from "@t3tools/client-runtime/state/fork-thread-ids";
export const resetForkThreadOrder = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork-order-reset",
  tag: "fork.threads.order.reset",
});

/** Hosts whose order metadata is loaded, and those that also accept order reset. Read once per list. */
export function useForkOrderHosts() {
  const readyHosts = useSupervisionReadyHosts();
  const configs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(() => {
    const resetSupported = new Set<EnvironmentId>();
    for (const environmentId of readyHosts) {
      if (configs.get(environmentId)?.environment.capabilities.threadOrderReset === true)
        resetSupported.add(environmentId);
    }
    return { ready: readyHosts, resetSupported };
  }, [readyHosts, configs]);
}
