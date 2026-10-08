import * as Effect from "effect/Effect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { supervision } from "./forkSupervision";

/** Subproject mode lives in the nesting sidecar: on makes a nested thread a subproject, off a plain worker. */
export const setThreadSubprojectCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "thread-subproject-set",
  tag: "fork.threads.metadata.update",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(supervision.query({ environmentId, input: {} }))),
});
