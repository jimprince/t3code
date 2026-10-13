import { describe, expect, it } from "vite-plus/test";

import { formatHarnessSchedule } from "./harnessSchedule.ts";

// Saturday 2026-10-10 13:41 in Calgary (MDT, UTC-6), and a January day (MST, UTC-7).
const OCTOBER = Date.parse("2026-10-10T19:41:00.000Z");
const JANUARY = Date.parse("2027-01-12T19:41:00.000Z");
const CALGARY = { now: OCTOBER, deviceZone: "America/Edmonton" } as const;
const UTC_DEVICE = { now: OCTOBER, deviceZone: "UTC" } as const;

const schedule = (value: unknown, suffix = "") => `${JSON.stringify(value)}${suffix}`;
const automation = (value: unknown) => schedule([{ type: "schedule", schedule: value }]);

describe("formatHarnessSchedule", () => {
  it("reads the stored automation triggers as words, in the device clock", () => {
    const daily = automation({ kind: "daily", time: "01:00", timeZone: "America/Edmonton" });
    expect(formatHarnessSchedule(daily, CALGARY)).toBe("Daily 01:00");
    expect(formatHarnessSchedule(automation({ kind: "hourly", timeZone: "UTC" }), CALGARY)).toBe(
      "Hourly",
    );
  });

  it("adds the schedule's own clock only when the two zones read differently", () => {
    const daily = automation({ kind: "daily", time: "01:00", timeZone: "America/Edmonton" });
    expect(formatHarnessSchedule(daily, UTC_DEVICE)).toBe("Daily 07:00 (01:00 MDT)");
    // Standard time: the same wall clock is one hour further from UTC.
    const denver = automation({ kind: "daily", time: "01:00", timeZone: "America/Denver" });
    expect(formatHarnessSchedule(denver, UTC_DEVICE)).toBe("Daily 07:00 (01:00 MDT)");
    expect(formatHarnessSchedule(denver, { ...UTC_DEVICE, now: JANUARY })).toBe(
      "Daily 08:00 (01:00 MST)",
    );
    const sameWallClock = automation({ kind: "daily", time: "01:00", timeZone: "UTC" });
    expect(formatHarnessSchedule(sameWallClock, UTC_DEVICE)).toBe("Daily 01:00");
  });

  it("moves a weekly day when the device zone crosses midnight", () => {
    const sunday = automation({
      kind: "weekly",
      time: "22:00",
      day: 0,
      timeZone: "America/Edmonton",
    });
    expect(formatHarnessSchedule(sunday, CALGARY)).toBe("Weekly Sun 22:00");
    expect(formatHarnessSchedule(sunday, UTC_DEVICE)).toBe("Weekly Mon 04:00 (22:00 MDT)");
    const weekdays = automation({
      kind: "weekdays",
      time: "09:00",
      days: [1, 2, 3, 4, 5],
      timeZone: "America/Edmonton",
    });
    expect(formatHarnessSchedule(weekdays, CALGARY)).toBe("Mon-Fri 09:00");
  });

  it("reads the common cron shapes and shows any other expression as itself", () => {
    const cron = (expression: string) =>
      formatHarnessSchedule(
        automation({ kind: "cron", expression, timeZone: "America/Edmonton" }),
        CALGARY,
      );
    expect(cron("0 7,17 * * *")).toBe("Daily 07:00, 17:00");
    expect(cron("17 2,5,8,11,14,17,20,23 * * *")).toBe("Every 3 h at :17");
    expect(cron("*/10 * * * *")).toBe("Every 10 min");
    expect(cron("5 * * * *")).toBe("Hourly at :05");
    expect(cron("0 9 * * 1")).toBe("Weekly Mon 09:00");
    expect(cron("0 9 1 * *")).toBe("Cron 0 9 1 * *");
  });

  it("reads a scheduled task's interval and fixed time, in the server zone it names", () => {
    expect(formatHarnessSchedule(schedule({ type: "interval", everyMs: 1_800_000 }), CALGARY)).toBe(
      "Every 30 min",
    );
    expect(
      formatHarnessSchedule(schedule({ type: "interval", everyMs: 14_400_000 }), CALGARY),
    ).toBe("Every 4 h");
    const saturdayNight = schedule(
      { type: "fixed_time", timeOfDay: "03:00", weekdays: [6] },
      "; server zone UTC",
    );
    // 03:00 UTC on Saturday is Friday evening in Calgary.
    expect(formatHarnessSchedule(saturdayNight, CALGARY)).toBe("Fri 21:00 (03:00 UTC)");
    expect(
      formatHarnessSchedule(
        schedule({ type: "fixed_time", timeOfDay: "03:00" }, "; server zone UTC"),
        UTC_DEVICE,
      ),
    ).toBe("Daily 03:00");
  });

  it("says what an event or a manual-only automation waits for", () => {
    expect(formatHarnessSchedule(schedule([{ type: "event", event: "ci.failed" }]), CALGARY)).toBe(
      "On CI failed",
    );
    expect(formatHarnessSchedule("[]", CALGARY)).toBe("Manual only");
    expect(
      formatHarnessSchedule(
        schedule([
          { type: "event", event: "pull-request.opened" },
          { type: "schedule", schedule: { kind: "hourly", timeZone: "UTC" } },
        ]),
        CALGARY,
      ),
    ).toBe("On pull request opened, Hourly");
  });

  it("never shows raw JSON: a value it cannot read becomes a short plain label", () => {
    for (const raw of [
      schedule([{ type: "mystery", payload: { deep: true } }]),
      "{ not json",
      schedule([{ type: "schedule", schedule: { kind: "lunar" } }]),
      schedule([{ type: "schedule", schedule: { kind: "daily" } }]),
    ]) {
      const text = formatHarnessSchedule(raw, CALGARY);
      expect(text).toBe("Custom schedule");
      expect(text).not.toMatch(/[{}[\]"]/);
    }
  });

  it("passes a plain label from a feed through unchanged", () => {
    expect(formatHarnessSchedule("Disabled by owner; no state file expected", CALGARY)).toBe(
      "Disabled by owner; no state file expected",
    );
  });
});
