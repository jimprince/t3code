import { describe, expect, it } from "vite-plus/test";
import { latestScheduledRun, nextScheduledRun } from "./schedule.ts";

const at = (
  schedule: Extract<
    Parameters<typeof nextScheduledRun>[0][number],
    { type: "schedule" }
  >["schedule"],
) => [{ type: "schedule" as const, schedule }];

describe("automation schedules", () => {
  it("skips weekends for a weekday schedule", () => {
    // 2026-10-09 is a Friday.
    const triggers = at({
      kind: "weekdays",
      time: "09:00",
      days: [1, 2, 3, 4, 5],
      timeZone: "UTC",
    });
    expect(nextScheduledRun(triggers, "2026-10-09T10:00:00.000Z")).toBe("2026-10-12T09:00:00.000Z");
    expect(latestScheduledRun(triggers, "2026-10-11T12:00:00.000Z")).toBe(
      "2026-10-09T09:00:00.000Z",
    );
  });

  it("keeps the wall-clock time across a daylight-saving change", () => {
    const triggers = at({ kind: "daily", time: "03:00", timeZone: "America/Denver" });
    expect(nextScheduledRun(triggers, "2026-10-30T10:00:00.000Z")).toBe("2026-10-31T09:00:00.000Z");
    expect(nextScheduledRun(triggers, "2026-10-31T09:00:00.000Z")).toBe("2026-11-01T10:00:00.000Z");
  });

  it("uses the earliest next slot and latest past slot across triggers", () => {
    const triggers = [
      ...at({ kind: "cron", expression: "*/30 * * * *", timeZone: "UTC" }),
      ...at({ kind: "daily", time: "07:10", timeZone: "UTC" }),
    ];
    expect(nextScheduledRun(triggers, "2026-10-05T07:00:00.000Z")).toBe("2026-10-05T07:10:00.000Z");
    expect(latestScheduledRun(triggers, "2026-10-05T07:20:00.000Z")).toBe(
      "2026-10-05T07:10:00.000Z",
    );
    expect(nextScheduledRun([], "2026-10-05T07:00:00.000Z")).toBeNull();
  });
});
