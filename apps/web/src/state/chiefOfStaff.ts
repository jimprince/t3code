import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { selectChiefOfStaffThread } from "../components/cos-tray/cosTray.logic";
import { useEnvironmentDashboardSnapshot } from "./dashboard";
import { useThreadShell } from "./entities";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

/**
 * The front desk thread as a key string, so the layout re-renders only when the thread itself
 * changes and not on every shell update while agents run.
 */
const chiefOfStaffKeyAtom = Atom.make((get) => {
  let preferred: ScopedThreadRef | null = null;
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    const threadId = config.settings?.chiefOfStaffThreadId;
    if (threadId) {
      preferred = { environmentId, threadId };
      break;
    }
  }
  const found = selectChiefOfStaffThread({
    threads: get(environmentThreadShells.threadShellsAtom),
    preferred,
    primaryEnvironmentId: get(primaryEnvironmentIdAtom),
  });
  return found ? scopedThreadKey(found) : null;
}).pipe(Atom.withLabel("web-chief-of-staff-key"));

export function useChiefOfStaffRef(): ScopedThreadRef | null {
  const key = useAtomValue(chiefOfStaffKeyAtom);
  return useMemo(() => (key === null ? null : parseScopedThreadKey(key)), [key]);
}

/**
 * What the pinned row, tray and sheet show: the front desk thread, how many decisions wait on
 * Brad in its environment, when it last replied (its latest finished run), and whether it is
 * replying now. Null when no thread is configured or found.
 */
export function useChiefOfStaff() {
  const ref = useChiefOfStaffRef();
  const shell = useThreadShell(ref);
  const snapshot = useEnvironmentDashboardSnapshot(ref?.environmentId ?? null);
  return useMemo(() => {
    if (!ref || !shell) return null;
    const waiting =
      snapshot?.projects.reduce((sum, project) => sum + project.attention.length, 0) ?? 0;
    return {
      ref,
      title: shell.title,
      waiting,
      lastReplyAt: shell.latestRun?.completedAt ?? null,
      replying: threadRuntimeIsActive(shell.runtime),
    };
  }, [ref, shell, snapshot]);
}
