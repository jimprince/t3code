import { selectScopedChiefOfStaffThread } from "@t3tools/client-runtime/chief-of-staff";

/** open: full tray; minimized: a rail on desktop, a peek bar on a phone; closed: nothing on screen. */
export type CosTrayMode = "open" | "minimized" | "closed";

export const COS_TRAY_WIDTH = 360;
export const COS_TRAY_EXPANDED_WIDTH = 640;
export const COS_TRAY_RAIL_WIDTH = 36;
export const COS_TRAY_PEEK_HEIGHT = 56;
/** Under this window width the open tray overlays the page instead of taking a column. */
export const COS_TRAY_OVERLAY_BELOW = 1024;

/**
 * The row, key and palette all use this: a tray that is not showing opens, a showing one closes.
 * On a phone the sheet is what shows, and it never persists open, so a stored `open` mode after
 * a reload with the sheet closed (only the peek bar on screen) must open the sheet, not close.
 */
export function toggleCosTray(
  mode: CosTrayMode,
  phone?: { readonly sheetOpen: boolean },
): CosTrayMode {
  const showing = phone ? phone.sheetOpen : mode === "open";
  return showing ? "closed" : "open";
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

// Compatibility export for existing tray consumers; selection is shared with every client.
export const selectChiefOfStaffThread = selectScopedChiefOfStaffThread;
