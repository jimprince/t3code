import { useAtomValue } from "@effect/atom-react";
import { Atom } from "effect/unstable/reactivity";
import { environmentThreadShells } from "../../state/threads";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionForest,
  supervisionThreadKey,
  supervisionIsActive,
} from "@t3tools/client-runtime/state/fork-nesting";

import { supervision } from "../../state/forkSupervision";
const countAtom = Atom.family((key: string) =>
  Atom.make((get) => get(supervision.forest).activeCounts.get(key) ?? 0),
);
export function useSupervisionStatus(thread: EnvironmentThreadShell) {
  const count = useAtomValue(countAtom(supervisionThreadKey(thread)));
  return {
    count,
    supervising: count > 0 && thread.settledOverride !== "settled" && !supervisionIsActive(thread),
  };
}
