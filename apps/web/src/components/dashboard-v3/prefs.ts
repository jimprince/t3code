import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * A, B and C are the three designs under review; "previous" is the Dashboard that shipped before
 * them, kept reachable until Brad picks. A per-device preference, so Mac and phone may differ.
 */
export const DASHBOARD_VARIANTS = ["A", "B", "C", "previous"] as const;
export type DashboardVariant = (typeof DASHBOARD_VARIANTS)[number];

export const VARIANT_TITLE: Record<DashboardVariant, string> = {
  A: "A · Plan board",
  B: "B · Since you looked",
  C: "C · Executive grid",
  previous: "Previous dashboard",
};

const VariantSchema = Schema.Literals(DASHBOARD_VARIANTS);

export function useDashboardVariant() {
  return useLocalStorage("t3.dashboard.variant", "A" as DashboardVariant, VariantSchema);
}

const CollapsedSchema = Schema.Array(Schema.String);
const NO_KEYS: ReadonlyArray<string> = [];

/** Project, workstream and Utilities collapse state, persisted per device. */
export function useCollapsedKeys() {
  const [keys, setKeys] = useLocalStorage("t3.dashboard.collapsed", NO_KEYS, CollapsedSchema);
  // A key is stored only when it differs from the row's default, so defaults can change later.
  const toggle = useCallback(
    (key: string) =>
      setKeys((current) =>
        current.includes(key) ? current.filter((entry) => entry !== key) : [...current, key],
      ),
    [setKeys],
  );
  const isCollapsed = useCallback(
    (key: string, defaultCollapsed: boolean) =>
      keys.includes(key) ? !defaultCollapsed : defaultCollapsed,
    [keys],
  );
  return useMemo(() => ({ isCollapsed, toggle }), [isCollapsed, toggle]);
}

/** The wall clock, ticking once a minute: ages and "by 8:42" labels stay honest without animation. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
