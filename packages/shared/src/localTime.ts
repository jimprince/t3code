// @effect-diagnostics globalDate:off -- Device-zone calendar math reads the local zone through Date, like usageFormat.
/**
 * Dates and times as the viewer reads them: in the device's own time zone, never bare UTC.
 * Every function reads the zone at call time, so a device that travels stays correct.
 */

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (value: number) => String(value).padStart(2, "0");

/** The device-zone calendar day of an instant, as a day count: subtract two to count days. */
export function localCalendarDay(instant: number): number {
  const date = new Date(instant);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}

/**
 * When a deadline falls: an instant as written, and a date (`2026-10-08`) at the start of that
 * day in the device zone. NaN when unreadable.
 */
export function deadlineInstant(deadline: string): number {
  const date = DATE_ONLY.exec(deadline.trim());
  if (date === null) return Date.parse(deadline);
  return new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])).getTime();
}

/** A deadline in a few words, by device-zone day: "overdue", "due today", "due tomorrow", "due Oct 8". */
export function formatDeadline(deadline: string, now: number): string {
  const at = deadlineInstant(deadline);
  if (Number.isNaN(at)) return "";
  const days = localCalendarDay(at) - localCalendarDay(now);
  if (days < 0) return "overdue";
  if (days === 0) return "due today";
  if (days === 1) return "due tomorrow";
  return `due ${new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/** An ISO 8601 timestamp with the device's offset, for copied reports: `2026-10-10T11:37:59-06:00`. */
export function formatLocalIso(instant: number): string {
  const date = new Date(instant);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const offsetText = `${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offsetText}`
  );
}

/** "19:00 MDT": the wall clock and zone name at an instant, in `timeZone` or the device zone. */
export function zoneClock(instant: number, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.hour}:${parts.minute} ${parts.timeZoneName}`;
}

/**
 * A scheduled time in the device zone, with the schedule's own zone added only when its wall
 * clock differs: "03:00 MDT (09:00 UTC)", or just "01:00 MDT".
 */
export function formatInDeviceZone(instant: number, scheduleZone?: string): string {
  const device = zoneClock(instant);
  if (scheduleZone === undefined) return device;
  const schedule = zoneClock(instant, scheduleZone);
  return schedule === device ? device : `${device} (${schedule})`;
}
