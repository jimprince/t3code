import { useEffect, useMemo, useRef } from "react";

import { diffAgainst, takeBaseline, type Baseline, type DashboardData } from "./dashboard.logic";

/** How long the page must be visible before this device counts as having looked. */
const LOOKED_AFTER_MS = 10_000;

function read(key: string): Baseline | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Baseline) : null;
  } catch {
    return null;
  }
}

/**
 * What changed since this device last looked, derived on the client from the baseline it stored.
 * The baseline a visit compares against is the one stored before it began; a new one is stored only
 * after the page has been visible for ten seconds, so a quick glance does not swallow the changes.
 * Each scope (Home, one project page) keeps its own baseline.
 */
export function useVisitBaseline(scopeKey: string, data: DashboardData, enabled = true) {
  const storageKey = `t3.dashboard.baseline.${scopeKey}`;
  // Read once per scope, so the baseline a visit compares against does not move when this visit stores one.
  const previous = useMemo(() => read(storageKey), [storageKey]);
  const latest = useRef(data);
  useEffect(() => {
    latest.current = data;
  }, [data]);
  const hasData = enabled && data.asOf !== null;
  useEffect(() => {
    if (!hasData) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState !== "visible") return;
        try {
          window.localStorage.setItem(
            storageKey,
            JSON.stringify(takeBaseline(latest.current, new Date().toISOString())),
          );
        } catch {
          // Storage full or unavailable: the next visit simply has nothing to compare.
        }
      }, LOOKED_AFTER_MS);
    };
    const onVisibility = () =>
      document.visibilityState === "visible" ? arm() : clearTimeout(timer);
    document.addEventListener("visibilitychange", onVisibility);
    onVisibility();
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [hasData, storageKey]);
  return useMemo(
    () => (previous ? { baseline: previous, ...diffAgainst(data, previous) } : null),
    [data, previous],
  );
}
