import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import { automationScheduleText } from "./automationSchedule.ts";

beforeAll(() => {
  vi.stubEnv("TZ", "America/Edmonton");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const at = (value: string) => Date.parse(value);
const october = at("2026-10-06T01:00:00Z");

describe("automationScheduleText", () => {
  it("shows a schedule in the device zone, adding its own zone only when it differs", () => {
    expect(
      automationScheduleText(
        { kind: "daily", time: "01:00", timeZone: "America/Edmonton" },
        october,
      ),
    ).toBe("Daily 01:00 MDT");
    expect(automationScheduleText({ kind: "daily", time: "09:00", timeZone: "UTC" }, october)).toBe(
      "Daily 03:00 MDT (09:00 UTC)",
    );
    expect(
      automationScheduleText(
        { kind: "weekdays", time: "09:00", days: [5, 1, 2, 3, 4], timeZone: "UTC" },
        october,
      ),
    ).toBe("Weekdays 03:00 MDT (09:00 UTC)");
  });

  it("shifts the days when the zones disagree on the day", () => {
    expect(
      automationScheduleText({ kind: "weekly", time: "01:00", day: 1, timeZone: "UTC" }, october),
    ).toBe("Sun 19:00 MDT (Mon 01:00 UTC)");
    expect(
      automationScheduleText(
        { kind: "weekdays", time: "01:00", days: [1, 2, 3, 4, 5], timeZone: "UTC" },
        october,
      ),
    ).toBe("Sun, Mon, Tue, Wed, Thu 19:00 MDT (Weekdays 01:00 UTC)");
  });

  it("follows the offset in force on the day of the run", () => {
    expect(
      automationScheduleText(
        { kind: "daily", time: "09:00", timeZone: "UTC" },
        at("2026-03-01T12:00:00Z"),
      ),
    ).toBe("Daily 02:00 MST (09:00 UTC)");
    expect(
      automationScheduleText(
        { kind: "daily", time: "09:00", timeZone: "Europe/Berlin" },
        at("2026-10-06T01:00:00Z"),
      ),
    ).toBe("Daily 01:00 MDT (09:00 GMT+2)");
  });
});
