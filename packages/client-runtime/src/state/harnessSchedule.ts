// @effect-diagnostics globalDate:off -- Zone wall-clock math reads Intl and Date.UTC directly, like shared localTime.
import { zoneClock } from "@t3tools/shared/localTime";

/**
 * A check's schedule in words. The snapshot's `scheduleOrTrigger` is the stored trigger JSON
 * (`[{"type":"schedule","schedule":{"kind":"daily",...}}]`, a scheduled task's bare
 * `{"type":"interval",...}` plus "; server zone X"), or already a plain label from a feed. Times
 * are shown in the device zone; the schedule's own clock is added only when it reads differently.
 */

export interface HarnessScheduleOptions {
  /** The instant "today" is read at; DST offsets are taken around it. */
  readonly now: number;
  /** IANA zone the viewer is in; defaults to the device zone. Tests pin it. */
  readonly deviceZone?: string | undefined;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const SERVER_ZONE_SUFFIX = /;\s*server zone\s+(.+)$/;
const EVENT_LABELS: Record<string, string> = {
  "pull-request.opened": "pull request opened",
  "ci.failed": "CI failed",
  "issue.labeled": "issue labeled",
  "worker.blocked": "worker blocked",
  "release.published": "release published",
};
/** Shown when a schedule value is structured but not one this formatter knows. */
const UNKNOWN_SCHEDULE = "Custom schedule";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Milliseconds `zone` is ahead of UTC at `instant`. */
function zoneOffsetMs(instant: number, zone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(instant)
      .map((part) => [part.type, Number(part.value)]),
  );
  const wall = Date.UTC(
    parts.year ?? 1970,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** Calendar day of `instant` in `zone`, as a UTC midnight: weekday and day arithmetic stay exact. */
function zoneDay(instant: number, zone: string): number {
  const wall = instant + zoneOffsetMs(instant, zone);
  return Math.floor(wall / 86_400_000) * 86_400_000;
}

/** The instant a wall clock `time` ("HH:MM") reads on `dayUtc` (a zone calendar day) in `zone`. */
function instantOfWallClock(dayUtc: number, time: string, zone: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (match === null) return null;
  const guess = dayUtc + (Number(match[1]) * 60 + Number(match[2])) * 60_000;
  // The zone's offset can differ at the target instant (DST), so settle it with a second pass.
  const first = guess - zoneOffsetMs(guess, zone);
  return guess - zoneOffsetMs(first, zone);
}

function clockAt(instant: number, zone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}

function weekdayAt(instant: number, zone: string | undefined): number {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(
    instant,
  );
  return WEEKDAYS.indexOf(name as (typeof WEEKDAYS)[number]);
}

function isZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** "Mon-Fri", "Sat", "Mon, Wed, Fri": consecutive days collapse to a range, every day to null. */
function describeDays(days: ReadonlyArray<number>): string | null {
  const sorted = [...new Set(days)].sort((left, right) => left - right);
  if (sorted.length === 0 || sorted.length === 7) return null;
  const ranges: string[] = [];
  for (let index = 0; index < sorted.length;) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end += 1;
    const first = WEEKDAYS[sorted[index] ?? 0];
    const last = WEEKDAYS[sorted[end] ?? 0];
    ranges.push(
      end - index >= 2
        ? `${first}-${last}`
        : sorted
            .slice(index, end + 1)
            .map((day) => WEEKDAYS[day])
            .join(", "),
    );
    index = end + 1;
  }
  return ranges.join(", ");
}

interface Context extends HarnessScheduleOptions {
  /** The zone a bare wall-clock time (a scheduled task's `fixed_time`) was written in. */
  readonly serverZone: string | undefined;
}

/**
 * A recurring wall-clock time on weekdays, in the device zone. `scheduleZone` is the zone the time
 * was written in; the device clock replaces it, and the schedule's own clock follows in brackets
 * only when the two read differently. A weekday that crosses midnight between the zones moves too.
 */
function describeWallClock(
  time: string,
  days: ReadonlyArray<number> | null,
  scheduleZone: string | undefined,
  context: Context,
): string | null {
  const deviceZone = context.deviceZone;
  const zone = scheduleZone ?? deviceZone;
  if (zone === undefined) {
    // No zone known on either side: show the time as written.
    const dayText = days === null ? null : describeDays(days);
    return dayText === null ? time : `${dayText} ${time}`;
  }
  const today = zoneDay(context.now, zone);
  const todayWeekday = new Date(today).getUTCDay();
  // One concrete occurrence per listed day, converted to the device zone.
  const targets = (days ?? [todayWeekday]).map((day) => {
    const ahead = (day - todayWeekday + 7) % 7;
    const instant = instantOfWallClock(today + ahead * 86_400_000, time, zone);
    return instant === null ? null : { day, instant };
  });
  if (targets.some((target) => target === null)) return null;
  const resolved = targets.filter((target) => target !== null);
  const first = resolved[0];
  if (first === undefined) return null;
  const deviceClock = clockAt(first.instant, deviceZone);
  const deviceDays =
    days === null ? null : resolved.map((target) => weekdayAt(target.instant, deviceZone));
  const dayText = deviceDays === null ? null : describeDays(deviceDays);
  const scheduleClock = clockAt(first.instant, zone);
  const note = scheduleClock === deviceClock ? "" : ` (${zoneClock(first.instant, zone)})`;
  return `${dayText === null ? "" : `${dayText} `}${deviceClock}${note}`;
}

function describeInterval(everyMs: number): string | null {
  if (!Number.isFinite(everyMs) || everyMs <= 0) return null;
  const minutes = Math.round(everyMs / 60_000);
  if (minutes < 1) return `Every ${Math.max(1, Math.round(everyMs / 1000))} s`;
  if (minutes < 120 && minutes % 60 !== 0) return `Every ${minutes} min`;
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return days === 1 ? "Daily" : `Every ${days} d`;
  }
  if (minutes % 60 === 0) return `Every ${minutes / 60} h`;
  return `Every ${minutes} min`;
}

/** The step of four or more hours that divide the day evenly ("2,5,8,...": 3), else null. */
function evenHourStep(hours: ReadonlyArray<number>): number | null {
  if (hours.length < 4) return null;
  const step = 24 / hours.length;
  if (!Number.isInteger(step)) return null;
  const sorted = [...hours].sort((left, right) => left - right);
  return sorted.every((hour, index) => index === 0 || hour - (sorted[index - 1] ?? 0) === step)
    ? step
    : null;
}

/** The simple cron shapes people write; anything else is shown as the expression itself. */
function describeCron(expression: string, zone: string | undefined, context: Context): string {
  const fields = expression.trim().split(/\s+/);
  const verbatim = () => {
    const where = zone !== undefined && zone !== context.deviceZone ? ` ${zone}` : "";
    return `Cron ${expression.trim()}${where}`;
  };
  if (fields.length !== 5) return verbatim();
  const [minute = "", hour = "", dayOfMonth = "", month = "", weekday = ""] = fields;
  if (dayOfMonth !== "*" || month !== "*") return verbatim();
  const everyN = /^\*\/(\d+)$/.exec(minute);
  if (everyN !== null && hour === "*" && weekday === "*") return `Every ${everyN[1]} min`;
  if (!/^\d+$/.test(minute)) return verbatim();
  if (hour === "*" && weekday === "*") return `Hourly at :${minute.padStart(2, "0")}`;
  const stepHours = /^\*\/(\d+)$/.exec(hour);
  if (stepHours !== null && weekday === "*") {
    return `Every ${stepHours[1]} h at :${minute.padStart(2, "0")}`;
  }
  const hours = hour.split(",");
  if (!hours.every((entry) => /^\d{1,2}$/.test(entry))) return verbatim();
  const evenStep = evenHourStep(hours.map(Number));
  if (evenStep !== null && weekday === "*") {
    return `Every ${evenStep} h at :${minute.padStart(2, "0")}`;
  }
  const days = weekday === "*" ? null : weekday.split(",").map(Number);
  if (days !== null && !days.every((day) => Number.isInteger(day) && day >= 0 && day <= 7)) {
    return verbatim();
  }
  const normalizedDays = days === null ? null : days.map((day) => day % 7);
  const times = hours.map((entry) =>
    describeWallClock(`${entry}:${minute.padStart(2, "0")}`, normalizedDays, zone, context),
  );
  if (times.some((time) => time === null)) return verbatim();
  return `${normalizedDays === null ? "Daily" : "Weekly"} ${times.join(", ")}`;
}

function describeSchedule(schedule: Record<string, unknown>, context: Context): string | null {
  const zone = isZone(schedule.timeZone) ? schedule.timeZone : undefined;
  switch (schedule.kind) {
    case "hourly":
      return "Hourly";
    case "daily":
      return typeof schedule.time === "string"
        ? (() => {
            const text = describeWallClock(schedule.time, null, zone, context);
            return text === null ? null : `Daily ${text}`;
          })()
        : null;
    case "weekly":
      return typeof schedule.time === "string" && typeof schedule.day === "number"
        ? (() => {
            const text = describeWallClock(schedule.time, [schedule.day], zone, context);
            return text === null ? null : `Weekly ${text}`;
          })()
        : null;
    case "weekdays":
      return typeof schedule.time === "string" && Array.isArray(schedule.days)
        ? describeWallClock(
            schedule.time,
            schedule.days.filter((day): day is number => typeof day === "number"),
            zone,
            context,
          )
        : null;
    case "cron":
      return typeof schedule.expression === "string"
        ? describeCron(schedule.expression, zone, context)
        : null;
    default:
      return null;
  }
}

function describeTrigger(trigger: unknown, context: Context): string | null {
  if (!isRecord(trigger)) return null;
  switch (trigger.type) {
    case "schedule":
      return isRecord(trigger.schedule) ? describeSchedule(trigger.schedule, context) : null;
    case "event":
      return typeof trigger.event === "string"
        ? `On ${EVENT_LABELS[trigger.event] ?? trigger.event}`
        : null;
    case "interval":
      return typeof trigger.everyMs === "number" ? describeInterval(trigger.everyMs) : null;
    case "fixed_time": {
      if (typeof trigger.timeOfDay !== "string") return null;
      const days = Array.isArray(trigger.weekdays)
        ? trigger.weekdays.filter((day): day is number => typeof day === "number")
        : [];
      const text = describeWallClock(
        trigger.timeOfDay,
        days.length === 0 ? null : days,
        context.serverZone,
        context,
      );
      return text === null ? null : days.length === 0 || days.length === 7 ? `Daily ${text}` : text;
    }
    case "webhook":
      return "On webhook";
    default:
      return typeof trigger.kind === "string" ? describeSchedule(trigger, context) : null;
  }
}

/**
 * The schedule text for a row or page: "Daily 01:00", "Every 30 min", "Mon-Fri 09:00", "On CI
 * failed", "Manual only". A plain label from a feed passes through; structured text this cannot
 * read becomes "Custom schedule", never raw JSON.
 */
export function formatHarnessSchedule(raw: string, options: HarnessScheduleOptions): string {
  const text = raw.trim();
  const suffix = SERVER_ZONE_SUFFIX.exec(text);
  const body = (suffix === null ? text : text.slice(0, suffix.index)).trim();
  if (!body.startsWith("[") && !body.startsWith("{")) return text;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return UNKNOWN_SCHEDULE;
  }
  const serverZone = isZone(suffix?.[1]?.trim()) ? suffix?.[1]?.trim() : undefined;
  const triggers: ReadonlyArray<unknown> = Array.isArray(value) ? value : [value];
  if (triggers.length === 0) return "Manual only";
  const described = triggers.map((trigger) => describeTrigger(trigger, { ...options, serverZone }));
  if (described.some((part) => part === null)) return UNKNOWN_SCHEDULE;
  return [...new Set(described)].join(", ");
}
