import type { EnvironmentId } from "@t3tools/contracts";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../../connection/runtime";
import { supervision } from "../../state/forkSupervision";

export { newForkCommandId } from "@t3tools/client-runtime/state/fork-thread-ids";
export const forkConversation = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork-conversation",
  tag: "orchestration.forkThread",
});
export const resetForkThreadOrder = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "fork-order-reset",
  tag: "fork.threads.order.reset",
});

/** Order reset needs the capability and a loaded sidecar, in every menu that offers it. */
export const readForkOrderResetSupported = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(supervision.readyHosts).has(environmentId) &&
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
    .threadOrderReset === true;

/** Nesting needs the capability and a loaded sidecar, in every surface that offers it. */
export const readForkNestingSupported = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(supervision.readyHosts).has(environmentId) &&
  appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
    .threadNesting === true;
