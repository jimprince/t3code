import type { DesktopUpdateState } from "@t3tools/contracts";

import { resolveDesktopUpdateButtonAction } from "../desktopUpdate.logic";

/** Updates install on their own between 01:00 and 06:00 local time. */
const OVERNIGHT_START_HOUR = 1;
const OVERNIGHT_END_HOUR = 6;

/** How long the window must go untouched before an update restarts it. */
export const OVERNIGHT_USER_QUIET_MS = 5 * 60_000;

export function isOvernight(now: Date): boolean {
  const hour = now.getHours();
  return hour >= OVERNIGHT_START_HOUR && hour < OVERNIGHT_END_HOUR;
}

export type OvernightUpdateStep =
  | {
      readonly type: "download" | "install";
      readonly key: string;
      readonly minimumSystemIdleSeconds?: number;
    }
  | { readonly type: "wait" };

/**
 * Overnight downloads keep their schedule and retries. Daytime updates also
 * require system idle time, and are attempted once per version. Both install
 * paths require no local agent work and a quiet window.
 */
export function resolveOvernightUpdateStep(input: {
  readonly state: DesktopUpdateState | null;
  readonly now: Date;
  readonly userQuiet: boolean;
  readonly busyAgentCount: number;
  readonly attempted: ReadonlySet<string>;
  readonly installUpdatesWhenIdle?: boolean;
  readonly updateIdleMinutes?: number;
  readonly systemIdleSeconds?: number | null;
}): OvernightUpdateStep {
  const { state, now } = input;
  if (state === null || !state.enabled) return { type: "wait" };
  const overnight = isOvernight(now);
  const minimumSystemIdleSeconds = (input.updateIdleMinutes ?? 15) * 60;
  const systemIdleSeconds = input.systemIdleSeconds;
  const daytimeIdle =
    (input.installUpdatesWhenIdle ?? true) &&
    typeof systemIdleSeconds === "number" &&
    Number.isFinite(systemIdleSeconds) &&
    systemIdleSeconds >= minimumSystemIdleSeconds &&
    input.busyAgentCount === 0;
  if (!overnight && !daytimeIdle) return { type: "wait" };
  const night = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const action = resolveDesktopUpdateButtonAction(state);
  let step: OvernightUpdateStep = { type: "wait" };
  if (action === "download" && state.availableVersion) {
    step = {
      type: "download",
      key: overnight
        ? `download ${state.availableVersion} ${night}`
        : `download ${state.availableVersion} idle`,
    };
  } else if (
    action === "install" &&
    state.downloadedVersion &&
    (input.userQuiet || !overnight) &&
    input.busyAgentCount === 0
  ) {
    const daytimeKey = `install ${state.downloadedVersion} idle`;
    if (input.attempted.has(daytimeKey)) return { type: "wait" };
    if (
      !overnight &&
      [...input.attempted].some((key) => key.startsWith(`install ${state.downloadedVersion} `))
    ) {
      return { type: "wait" };
    }
    step = overnight
      ? { type: "install", key: `install ${state.downloadedVersion} ${night}` }
      : { type: "install", key: daytimeKey, minimumSystemIdleSeconds };
  }
  return step.type !== "wait" && input.attempted.has(step.key) ? { type: "wait" } : step;
}
