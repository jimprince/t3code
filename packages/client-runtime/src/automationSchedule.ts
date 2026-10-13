// @effect-diagnostics globalDate:off -- Schedule wall clocks are read through Intl and Date in the device zone.
import type { AutomationSchedule } from "@t3tools/contracts";
import { formatInDeviceZone, zoneClock } from "@t3tools/shared/localTime";

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function zoneParts(instant: number, timeZone?: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: SHORT_DAYS.indexOf(parts.weekday ?? ""),
    zone: parts.timeZoneName ?? "",
    wall: Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
    ),
  };
}

/** The instant `time` ("09:00") falls on the calendar day of `at` in `timeZone`. */
function occurrence(at: number, time: string, timeZone: string): number {
  const date = new Date(zoneParts(at, timeZone).wall);
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  const wall = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  const offset = (instant: number) =>
    zoneParts(instant, timeZone).wall - Math.floor(instant / 60_000) * 60_000;
  return wall - offset(wall - offset(wall));
}

function daysText(days: ReadonlyArray<number>): string {
  const sorted = [...days].sort((a, b) => a - b);
  return sorted.join(",") === "1,2,3,4,5"
    ? "Weekdays"
    : sorted.map((day) => SHORT_DAYS[day]).join(", ");
}

/**
 * A schedule as the viewer reads it, in the device zone with the schedule's zone added when it
 * differs: "Daily 03:00 MDT (09:00 UTC)". When the zones disagree on the day, the days shift
 * and the schedule's own days follow: "Sun 19:00 MDT (Mon 01:00 UTC)". `at` picks the day whose
 * offsets apply; pass the next run.
 */
export function automationScheduleText(schedule: AutomationSchedule, at: number): string {
  if (schedule.kind === "hourly") return "Hourly";
  if (schedule.kind === "cron") {
    return `Cron ${schedule.expression} ${zoneParts(at, schedule.timeZone).zone}`;
  }
  const when = occurrence(at, schedule.time, schedule.timeZone);
  if (schedule.kind === "daily") return `Daily ${formatInDeviceZone(when, schedule.timeZone)}`;
  const days = schedule.kind === "weekly" ? [schedule.day] : schedule.days;
  const shift = (zoneParts(when).day - zoneParts(when, schedule.timeZone).day + 7) % 7;
  if (shift === 0) return `${daysText(days)} ${formatInDeviceZone(when, schedule.timeZone)}`;
  const deviceDays = daysText(days.map((day) => (day + shift) % 7));
  return `${deviceDays} ${zoneClock(when)} (${daysText(days)} ${zoneClock(when, schedule.timeZone)})`;
}
