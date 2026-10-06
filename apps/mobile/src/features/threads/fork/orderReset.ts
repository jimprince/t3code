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

export function useForkOrderResetSupported(environmentId: EnvironmentId) {
  return (
    useAtomValue(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadOrderReset === true
  );
}
