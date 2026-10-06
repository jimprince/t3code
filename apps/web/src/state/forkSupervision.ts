import { useAtomValue } from "@effect/atom-react";
import * as Effect from "effect/Effect";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { createSupervisionAtoms } from "@t3tools/client-runtime/state/fork-nesting-query";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

export const supervision = createSupervisionAtoms(
  connectionAtomRuntime,
  environmentThreadShells.threadShellsAtom,
);
export const useSupervisionForest = () => useAtomValue(supervision.forest);
/** One thread's descendants as "id\ttitle" lines; a string, so unrelated shell churn is silent. */
export const useSupervisionWorkerLines = (threadKey: string) =>
  useAtomValue(supervision.workerLines(threadKey));
export const useSupervisionMetadata = () => useAtomValue(supervision.metadata);

export const useSupervisionReadyHosts = () => useAtomValue(supervision.readyHosts);

/** Every nest, reorder, and un-nest gesture reaches the sidecar through this one command. */
export const supervisionDropCommand = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "supervision-drop",
  tag: "fork.threads.supervision.drop",
  onSuccess: ({ environmentId }, registry) =>
    Effect.sync(() => registry.refresh(supervision.query({ environmentId, input: {} }))),
});
