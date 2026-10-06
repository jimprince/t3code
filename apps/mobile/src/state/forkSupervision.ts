import { useAtomValue } from "@effect/atom-react";
import { createSupervisionAtoms } from "@t3tools/client-runtime/state/fork-nesting-query";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentThreadShells } from "./threads";

export const supervision = createSupervisionAtoms(
  connectionAtomRuntime,
  environmentThreadShells.threadShellsAtom,
);
export const useSupervisionForest = () => useAtomValue(supervision.forest);
export const useSupervisionMetadata = () => useAtomValue(supervision.metadata);

export const useSupervisionReadyHosts = () => useAtomValue(supervision.readyHosts);
