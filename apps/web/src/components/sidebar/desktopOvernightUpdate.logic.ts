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
  | { readonly type: "download" | "install"; readonly key: string }
  | { readonly type: "wait" };

/**
 * What the overnight updater should do now. A download starts as soon as the
 * night begins; an install also waits until no local agent is working and the
 * user has left the window alone. Each step is tried once per version per
 * night, so a failure waits for the next night instead of looping.
 */
export function resolveOvernightUpdateStep(input: {
  readonly state: DesktopUpdateState | null;
  readonly now: Date;
  readonly userQuiet: boolean;
  readonly busyAgentCount: number;
  readonly attempted: ReadonlySet<string>;
}): OvernightUpdateStep {
  const { state, now } = input;
  if (state === null || !state.enabled || !isOvernight(now)) return { type: "wait" };
  const night = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const action = resolveDesktopUpdateButtonAction(state);
  let step: OvernightUpdateStep = { type: "wait" };
  if (action === "download" && state.availableVersion) {
    step = { type: "download", key: `download ${state.availableVersion} ${night}` };
  } else if (
    action === "install" &&
    state.downloadedVersion &&
    input.userQuiet &&
    input.busyAgentCount === 0
  ) {
    step = { type: "install", key: `install ${state.downloadedVersion} ${night}` };
  }
  return step.type !== "wait" && input.attempted.has(step.key) ? { type: "wait" } : step;
}
