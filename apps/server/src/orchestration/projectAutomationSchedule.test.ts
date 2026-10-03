import { describe, expect, it } from "vite-plus/test";
import { latestAutomationRun, nextAutomationRun } from "./projectAutomationSchedule.ts";

describe("automation calendar", () => {
  it("uses the next clock hour, daily local time, and weekly weekday", () => {
    expect(nextAutomationRun({ kind: "hourly", timeZone: "UTC" }, "2026-10-03T06:15:00Z")).toBe(
      "2026-10-03T07:00:00.000Z",
    );
    expect(
      nextAutomationRun(
        { kind: "daily", time: "09:00", timeZone: "America/Toronto" },
        "2026-10-03T06:15:00Z",
      ),
    ).toBe("2026-10-03T13:00:00.000Z");
    expect(
      nextAutomationRun(
        { kind: "weekly", day: 1, time: "09:00", timeZone: "America/Toronto" },
        "2026-10-03T06:15:00Z",
      ),
    ).toBe("2026-10-05T13:00:00.000Z");
  });
  it("keeps daily wall time across spring and fall DST offsets", () => {
    const schedule = { kind: "daily", time: "09:00", timeZone: "America/Toronto" } as const;
    expect(nextAutomationRun(schedule, "2026-03-07T14:00:00Z")).toBe("2026-03-08T13:00:00.000Z");
    expect(nextAutomationRun(schedule, "2026-10-31T13:00:00Z")).toBe("2026-11-01T14:00:00.000Z");
  });
  it("does not repeat a daily run in the fall overlap", () => {
    expect(
      nextAutomationRun(
        { kind: "daily", time: "01:30", timeZone: "America/Toronto" },
        "2026-11-01T05:30:00Z",
      ),
    ).toBe("2026-11-02T06:30:00.000Z");
  });
  it("resolves spring's missing wall time deterministically", () => {
    expect(
      nextAutomationRun(
        { kind: "daily", time: "02:30", timeZone: "America/Toronto" },
        "2026-03-07T07:30:00Z",
      ),
    ).toBe("2026-03-08T07:30:00.000Z");
  });
  it("does not fire the upcoming occurrence a fraction of a second early", () => {
    expect(
      latestAutomationRun({ kind: "hourly", timeZone: "UTC" }, "2026-10-03T05:59:59.999Z"),
    ).toBe("2026-10-03T05:00:00.000Z");
  });
  it("coalesces missed occurrences including the exact current boundary", () => {
    expect(latestAutomationRun({ kind: "hourly", timeZone: "UTC" }, "2026-10-03T06:00:00Z")).toBe(
      "2026-10-03T06:00:00.000Z",
    );
  });
});
