import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  selectChiefOfStaffSummary,
  selectScopedChiefOfStaffThread,
} from "@t3tools/client-runtime/chief-of-staff";
import { mountedDashboardSnapshotAtom } from "@t3tools/client-runtime/dashboard";
import { liveAttention } from "@t3tools/client-runtime/dashboard/live";
import type { DashboardSnapshot, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useCosTrayStore } from "../components/cos-tray/cosTrayStore";
import { useIsMobile } from "../hooks/useMediaQuery";
import { useEnvironmentDashboardSnapshot, useEnvironmentDashboardSource } from "./dashboard";
import { useThreadProjection, useThreadShell } from "./entities";
import { useLiveRuntimeRequests } from "./liveRuntimeRequests";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { environmentServerConfigsAtom } from "./server";
import { environmentThreadShells } from "./threads";

/**
 * The front desk thread as a key string, so the layout re-renders only when the thread itself
 * changes and not on every shell update while agents run.
 */
export const chiefOfStaffKeyAtom = Atom.make((get) => {
  const preferred: ScopedThreadRef[] = [];
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    const threadId = config.settings?.chiefOfStaffThreadId;
    if (threadId) preferred.push({ environmentId, threadId });
  }
  const found = selectScopedChiefOfStaffThread({
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

const NO_SNAPSHOT = Atom.make<DashboardSnapshot | null>(null);

/**
 * What the pinned row, tray and sheet show: the front desk thread, how many decisions wait on
 * Brad in its environment, when its newest assistant message arrived, and whether it is
 * replying now. Null when no thread is configured or found.
 */
export function useChiefOfStaff() {
  const ref = useChiefOfStaffRef();
  const shell = useThreadShell(ref);
  const projection = useThreadProjection(ref);
  const isMobile = useIsMobile();
  const trayOpen = useCosTrayStore((state) =>
    isMobile ? state.phoneSheetOpen : state.mode === "open",
  );
  // Only the visible tray's decision view owns a dashboard subscription. The sidebar observes
  // a mounted dashboard passively; it hides the count when neither view is open.
  const traySnapshot = useEnvironmentDashboardSnapshot(
    trayOpen ? (ref?.environmentId ?? null) : null,
  );
  const mountedSnapshot = useAtomValue(
    ref ? mountedDashboardSnapshotAtom(ref.environmentId) : NO_SNAPSHOT,
  );
  const snapshot = traySnapshot ?? mountedSnapshot;
  // Count what the pager lists: a snapshot ask its thread no longer holds is not waiting on Brad.
  // A snapshot only a Dashboard view holds (no tray) is passive and live.
  const traySource = useEnvironmentDashboardSource(trayOpen ? (ref?.environmentId ?? null) : null);
  const source = traySnapshot ? traySource : "live";
  const live = useLiveRuntimeRequests();
  return useMemo(() => {
    if (!ref || !shell) return null;
    const summary = selectChiefOfStaffSummary({
      thread: shell.source,
      dashboard: snapshot,
      projection: projection?.projection ?? null,
      keep: (attention) => liveAttention(ref.environmentId, attention, live, source),
    });
    return {
      ref,
      title: shell.title,
      waiting: summary.openDecisionCount,
      lastReplyAt: summary.lastReplyAt,
      replying: summary.isBusy,
    };
  }, [ref, shell, projection, snapshot, live, source]);
}
