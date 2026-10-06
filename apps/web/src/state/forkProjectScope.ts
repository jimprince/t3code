import * as Effect from "effect/Effect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";
import { supervision } from "./forkSupervision";

/** Project scope lives in the nesting sidecar, so writes go through its metadata RPC. */
export const updateProjectScopeCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "project-scope-update",
  tag: "fork.threads.metadata.update",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(supervision.query({ environmentId, input: {} }))),
});
