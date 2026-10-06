import type { AutomationSchedule, AutomationTrigger } from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as DateTime from "effect/DateTime";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function cron(schedule: AutomationSchedule): Cron.Cron {
  if (schedule.kind === "hourly") return Cron.parseUnsafe("0 * * * *", schedule.timeZone);
  if (schedule.kind === "cron") return Cron.parseUnsafe(schedule.expression, schedule.timeZone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  const days =
    schedule.kind === "weekly"
      ? String(schedule.day)
      : schedule.kind === "weekdays"
        ? schedule.days.join(",")
        : "*";
  return Cron.parseUnsafe(`${minute} ${hour} * * ${days}`, schedule.timeZone);
}

const schedules = (triggers: ReadonlyArray<AutomationTrigger>) =>
  triggers.flatMap((trigger) => (trigger.type === "schedule" ? [trigger.schedule] : []));

/** The earliest slot after `after` across every schedule trigger; null when none is scheduled. */
export function nextScheduledRun(
  triggers: ReadonlyArray<AutomationTrigger>,
  after: string,
): string | null {
  const next = schedules(triggers).map((schedule) =>
    Cron.next(cron(schedule), Date.parse(after)).getTime(),
  );
  return next.length === 0 ? null : iso(Math.min(...next));
}

/** The latest slot at or before `now`: a downtime backlog collapses to this one run. */
export function latestScheduledRun(
  triggers: ReadonlyArray<AutomationTrigger>,
  now: string,
): string | null {
  const at = Math.floor(Date.parse(now) / 1000) * 1000 + 1000;
  const previous = schedules(triggers).map((schedule) => Cron.prev(cron(schedule), at).getTime());
  return previous.length === 0 ? null : iso(Math.max(...previous));
}

/** The timezone run titles use: the first schedule's, else the server's. */
export function automationTimeZone(triggers: ReadonlyArray<AutomationTrigger>): string {
  return schedules(triggers)[0]?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}
