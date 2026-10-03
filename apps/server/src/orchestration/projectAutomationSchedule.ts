import type { ProjectAutomationSchedule } from "@t3tools/contracts";
import * as Cron from "effect/Cron";

function cron(schedule: ProjectAutomationSchedule) {
  if (schedule.kind === "hourly") return Cron.parseUnsafe("0 * * * *", schedule.timeZone);
  const [hour, minute] = schedule.time.split(":").map(Number);
  return Cron.parseUnsafe(
    `${minute} ${hour} * * ${schedule.kind === "weekly" ? schedule.day : "*"}`,
    schedule.timeZone,
  );
}

/** Calendar schedules follow the saved timezone; hourly runs use each clock hour. */
export function nextAutomationRun(schedule: ProjectAutomationSchedule, after: string): string {
  return Cron.next(cron(schedule), Date.parse(after)).toISOString();
}

/** Collapse a downtime backlog to its latest due occurrence. */
export function latestAutomationRun(schedule: ProjectAutomationSchedule, now: string): string {
  return Cron.prev(cron(schedule), Math.floor(Date.parse(now) / 1000) * 1000 + 1000).toISOString();
}
