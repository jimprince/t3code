import { readLocalAgentsBlockingRestart } from "./desktopHostedWork";
import { useEffect, useRef, useState } from "react";

import { useClientSettings, useClientSettingsHydrated } from "../../hooks/useSettings";
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
function useOvernightClock() {
  const [clock, setClock] = useState<{
    now: Date;
    userQuiet: boolean;
    systemIdleSeconds: number | null;
  }>(() => ({ now: new Date(), userQuiet: false, systemIdleSeconds: null }));
  useEffect(() => {
    let lastInteractionAt = Date.now();
    let disposed = false;
    let sampling = false;
    const sampleIdleTime = () => {
      const bridge = window.desktopBridge;
      if (sampling || !bridge?.getUpdateState) return;
      sampling = true;
      void bridge
        .getUpdateState()
        .then((state) => {
          if (!disposed)
            setClock((current) => ({
              ...current,
              systemIdleSeconds: state.systemIdleSeconds ?? null,
            }));
        })
        .catch(() => {
          if (!disposed) setClock((current) => ({ ...current, systemIdleSeconds: null }));
        })
        .finally(() => {
          sampling = false;
        });
    };
    sampleIdleTime();
    const onInteraction = () => {
      lastInteractionAt = Date.now();
      setClock({ now: new Date(), userQuiet: false, systemIdleSeconds: null });
    };
    const interval = window.setInterval(() => {
      setClock((current) => ({
        ...current,
        now: new Date(),
        userQuiet: Date.now() - lastInteractionAt >= OVERNIGHT_USER_QUIET_MS,
      }));
      sampleIdleTime();
    }, CLOCK_INTERVAL_MS);
    for (const event of INTERACTION_EVENTS) {
      window.addEventListener(event, onInteraction, { capture: true, passive: true });
    }
    return () => {
      disposed = true;
      window.clearInterval(interval);
      for (const event of INTERACTION_EVENTS) {
        window.removeEventListener(event, onInteraction, { capture: true });
      }
    };
  }, []);
  return clock;
}

/**
 * Installs desktop updates overnight or after daytime system idle: downloads the
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
  const { now, userQuiet, systemIdleSeconds } = useOvernightClock();
  const settings = useClientSettings();
  const settingsHydrated = useClientSettingsHydrated();
  const installing = useRef(false);
  const [attempted, setAttempted] = useState<ReadonlySet<string>>(() => new Set());
  const step = resolveOvernightUpdateStep({
    state,
    now,
    userQuiet,
    busyAgentCount,
    attempted,
    installUpdatesWhenIdle: settingsHydrated && settings.installUpdatesWhenIdle,
    updateIdleMinutes: settings.updateIdleMinutes,
    systemIdleSeconds,
  });
  const stepType = step.type;
  const stepKey = step.type === "wait" ? null : step.key;

  const minimumSystemIdleSeconds =
    step.type === "install" ? step.minimumSystemIdleSeconds : undefined;
  const downloadedVersion = state?.downloadedVersion;
  useEffect(() => {
    if (stepKey === null) return;
    const markAttempted = () => setAttempted((current) => new Set(current).add(stepKey));
    if (stepType === "download") {
      markAttempted();
      void window.desktopBridge?.downloadUpdate().catch(() => undefined);
      return;
    }
    const timer = window.setTimeout(() => {
      if (installing.current || readLocalAgentsBlockingRestart() > 0) return;
      installing.current = true;
      if (minimumSystemIdleSeconds === undefined) markAttempted();
      void installDownloadedUpdate(
        minimumSystemIdleSeconds !== undefined && downloadedVersion
          ? { expectedVersion: downloadedVersion, minimumSystemIdleSeconds }
          : downloadedVersion
            ? { expectedVersion: downloadedVersion }
            : undefined,
      )
        .then((accepted) => {
          if (accepted && minimumSystemIdleSeconds !== undefined) markAttempted();
        })
        .finally(() => {
          installing.current = false;
        });
    }, IDLE_RESTART_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [stepKey, stepType, minimumSystemIdleSeconds, downloadedVersion]);

  return null;
}
