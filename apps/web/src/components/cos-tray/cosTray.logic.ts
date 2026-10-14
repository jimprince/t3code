import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

/** open: full tray; minimized: a rail on desktop, a peek bar on a phone; closed: nothing on screen. */
export type CosTrayMode = "open" | "minimized" | "closed";

export const COS_TRAY_WIDTH = 360;
export const COS_TRAY_EXPANDED_WIDTH = 640;
export const COS_TRAY_RAIL_WIDTH = 36;
export const COS_TRAY_PEEK_HEIGHT = 56;
/** Under this window width the open tray overlays the page instead of taking a column. */
export const COS_TRAY_OVERLAY_BELOW = 1024;

/** The row, key and palette all use this: a closed or minimized tray opens, an open one closes. */
export function toggleCosTray(mode: CosTrayMode): CosTrayMode {
  return mode === "open" ? "closed" : "open";
}

export function waitingLabel(count: number): string {
  return `${count} waiting on you`;
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** "13:55" in the device's local time; the weekday leads only when the reply is from another day. */
export function formatLastReply(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = timeFormat.format(at);
  return at.toDateString() === now.toDateString() ? time : `${weekdayFormat.format(at)} ${time}`;
}

interface CandidateThread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly title: string;
  readonly archivedAt: string | null;
}

/** Only the exact front desk titles match, so Chief of Staff Operations is never picked by name. */
const FRONT_DESK_TITLE = /^(chief[ -]of[ -]staff|front desk)$/i;

/**
 * The front desk thread: the environment preference when one names a thread (not found means no
 * tray, never a guess), else the primary environment's thread with a front desk title.
 */
export function selectChiefOfStaffThread(input: {
  readonly threads: ReadonlyArray<CandidateThread>;
  readonly preferred: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null {
  const live = input.threads.filter((thread) => thread.archivedAt === null);
  const { preferred } = input;
  if (preferred) {
    const found = live.find(
      (thread) =>
        thread.environmentId === preferred.environmentId && thread.id === preferred.threadId,
    );
    return found ? { environmentId: found.environmentId, threadId: found.id } : null;
  }
  const found = live.find(
    (thread) =>
      thread.environmentId === input.primaryEnvironmentId &&
      FRONT_DESK_TITLE.test(thread.title.trim()),
  );
  return found ? { environmentId: found.environmentId, threadId: found.id } : null;
}
