import * as Effect from "effect/Effect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { joinOrchestratorMetadata } from "@t3tools/client-runtime/state/orchestrators";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import { purposeMoveFor, type PurposeMove } from "@t3tools/client-runtime/state/thread-purpose";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { readForkHarnessSupported } from "../components/chat/forkThreadCommands";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readThreadShells } from "./entities";
import { supervision } from "./forkSupervision";

/** Purpose lives in the nesting sidecar: Move to Harness and Move back write one override and nothing else. */
export const setThreadPurposeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-purpose-set",
  tag: "fork.threads.metadata.update",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(supervision.query({ environmentId, input: {} }))),
});

/**
 * The Move item a thread's menu or palette offers right now, or null. Read at open time from the
 * joined sidecar, so it follows the resolved purpose and says where a move back returns to.
 */
export function readThreadPurposeMove(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): PurposeMove | null {
  if (!readForkHarnessSupported(thread.environmentId)) return null;
  return purposeMoveFor(
    joinOrchestratorMetadata(readThreadShells(), appAtomRegistry.get(supervision.metadata)),
    supervisionThreadKey(thread),
  );
}
