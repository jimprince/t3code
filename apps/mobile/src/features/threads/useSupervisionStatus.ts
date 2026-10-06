import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentThreadShells } from "../../state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionForest,
  supervisionKey,
  supervisionIsActive,
} from "@t3tools/client-runtime/state/forkNesting";

// Build once per immutable snapshot; rows subscribe only to their numeric count.
const forests = new WeakMap<
  ReadonlyArray<EnvironmentThreadShell>,
  ReturnType<typeof supervisionForest>
>();
const countAtom = Atom.family((key: string) =>
  Atom.make((get) => {
    const shells = get(environmentThreadShells.threadShellsAtom);
    let forest = forests.get(shells);
    if (!forest) {
      forest = supervisionForest(shells);
      forests.set(shells, forest);
    }
    return forest.activeCounts.get(key) ?? 0;
  }),
);
export function useSupervisionStatus(thread: EnvironmentThreadShell) {
  const count = useAtomValue(countAtom(supervisionKey(thread)));
  return {
    count,
    supervising: count > 0 && thread.settledOverride !== "settled" && !supervisionIsActive(thread),
  };
}
