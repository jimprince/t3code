import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { installDownloadedUpdate, useLocalAgentsBlockingRestart } from "./desktopIdleRestart";
import { IDLE_RESTART_GRACE_MS } from "./desktopIdleRestart.logic";
import {
  OVERNIGHT_USER_QUIET_MS,
  resolveOvernightUpdateStep,
} from "./desktopOvernightUpdate.logic";

const CLOCK_INTERVAL_MS = 30_000;
const INTERACTION_EVENTS = ["pointerdown", "keydown", "wheel"] as const;

/** The local time and whether the user has left the window alone, re-read every 30 seconds. */
function useOvernightClock(): { readonly now: Date; readonly userQuiet: boolean } {
  const [clock, setClock] = useState(() => ({ now: new Date(), userQuiet: false }));
  useEffect(() => {
    let lastInteractionAt = Date.now();
    const onInteraction = () => {
      lastInteractionAt = Date.now();
      setClock((current) => (current.userQuiet ? { now: new Date(), userQuiet: false } : current));
    };
    const interval = window.setInterval(() => {
      setClock({
        now: new Date(),
        userQuiet: Date.now() - lastInteractionAt >= OVERNIGHT_USER_QUIET_MS,
      });
    }, CLOCK_INTERVAL_MS);
    for (const event of INTERACTION_EVENTS) {
      window.addEventListener(event, onInteraction, { capture: true, passive: true });
    }
    return () => {
      window.clearInterval(interval);
      for (const event of INTERACTION_EVENTS) {
        window.removeEventListener(event, onInteraction, { capture: true });
      }
    };
  }, []);
  return clock;
}

/**
 * Installs desktop updates overnight without being asked: downloads the
 * update, then restarts into it once local agents have stayed idle for the
 * usual grace period and nobody is using the window. The desktop app rolls
 * back an update that fails to start. Mounted once at AppRoot.
 */
export function DesktopOvernightUpdateWatcher() {
  return isElectron ? <OvernightUpdateWatcher /> : null;
}

function OvernightUpdateWatcher() {
  const state = useDesktopUpdateState();
  const busyAgentCount = useLocalAgentsBlockingRestart();
  const { now, userQuiet } = useOvernightClock();
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(() => new Set());
  const step = resolveOvernightUpdateStep({ state, now, userQuiet, busyAgentCount, attempted });
  const stepType = step.type;
  const stepKey = step.type === "wait" ? null : step.key;

  useEffect(() => {
    if (stepKey === null) return;
    const markAttempted = () => setAttempted((current) => new Set(current).add(stepKey));
    if (stepType === "download") {
      markAttempted();
      void window.desktopBridge?.downloadUpdate().catch(() => undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      markAttempted();
      void installDownloadedUpdate();
    }, IDLE_RESTART_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [stepKey, stepType]);

  return null;
}
