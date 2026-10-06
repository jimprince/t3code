import type { ProjectSidebarBucket } from "@t3tools/client-runtime/state/orchestrators";
import { useEffect, useRef, useState } from "react";

const PROJECT_SIDEBAR_PROMOTION_DELAY_MS = 30_000;

const BUCKET_RANK: Record<ProjectSidebarBucket, number> = {
  "needs-you": 0,
  working: 1,
  idle: 2,
  quiet: 3,
};

export interface DeferredProjectSidebarBucket {
  readonly displayed: ProjectSidebarBucket;
  readonly pending: ProjectSidebarBucket | null;
  readonly pendingSince: number | null;
}

export function reconcileProjectSidebarBuckets(
  previous: ReadonlyMap<string, DeferredProjectSidebarBucket>,
  desired: ReadonlyMap<string, ProjectSidebarBucket>,
  nowMs: number,
  promotionDelayMs = PROJECT_SIDEBAR_PROMOTION_DELAY_MS,
) {
  const state = new Map<string, DeferredProjectSidebarBucket>();
  let nextPromotionAt: number | null = null;
  for (const [key, bucket] of desired) {
    const prior = previous.get(key);
    if (!prior) {
      state.set(key, { displayed: bucket, pending: null, pendingSince: null });
      continue;
    }
    if (BUCKET_RANK[bucket] >= BUCKET_RANK[prior.displayed]) {
      state.set(key, { displayed: bucket, pending: null, pendingSince: null });
      continue;
    }
    const pendingSince = prior.pending === bucket ? (prior.pendingSince ?? nowMs) : nowMs;
    const promotesAt = pendingSince + promotionDelayMs;
    if (nowMs >= promotesAt) {
      state.set(key, { displayed: bucket, pending: null, pendingSince: null });
      continue;
    }
    state.set(key, { displayed: prior.displayed, pending: bucket, pendingSince });
    nextPromotionAt = nextPromotionAt === null ? promotesAt : Math.min(nextPromotionAt, promotesAt);
  }
  return { state, nextPromotionAt };
}

export function useDeferredProjectSidebarBuckets(
  entries: ReadonlyArray<readonly [string, ProjectSidebarBucket]>,
): ReadonlyMap<string, ProjectSidebarBucket> {
  const stateRef = useRef(new Map<string, DeferredProjectSidebarBucket>());
  const [displayed, setDisplayed] = useState<ReadonlyMap<string, ProjectSidebarBucket>>(
    () => new Map(entries),
  );

  useEffect(() => {
    const desired = new Map(entries);
    let disposed = false;
    let timer: number | null = null;
    const advance = () => {
      const next = reconcileProjectSidebarBuckets(stateRef.current, desired, Date.now());
      stateRef.current = next.state;
      if (disposed) return;
      setDisplayed(
        new Map(
          entries.map(([key, bucket]) => [key, next.state.get(key)?.displayed ?? bucket] as const),
        ),
      );
      timer =
        next.nextPromotionAt === null
          ? null
          : window.setTimeout(advance, Math.max(0, next.nextPromotionAt - Date.now()));
    };
    timer = window.setTimeout(advance, 0);
    return () => {
      disposed = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [entries]);

  return displayed;
}
