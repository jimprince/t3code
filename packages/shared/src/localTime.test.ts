import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  deadlineInstant,
  formatDeadline,
  formatInDeviceZone,
  formatLocalIso,
  localCalendarDay,
} from "./localTime.ts";

beforeAll(() => {
  vi.stubEnv("TZ", "America/Edmonton");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const at = (value: string) => Date.parse(value);

describe("localCalendarDay", () => {
  it("turns the day at local midnight, not at 18:00 MDT when UTC does", () => {
    const evening = at("2026-10-08T23:59:00-06:00");
    expect(localCalendarDay(at("2026-10-09T01:00:00Z"))).toBe(localCalendarDay(evening));
    expect(localCalendarDay(at("2026-10-09T00:00:00-06:00"))).toBe(localCalendarDay(evening) + 1);
  });
});

describe("deadlines", () => {
  const now = at("2026-10-08T19:00:00-06:00");

  it("reads a date-only deadline as the start of that day in the device zone", () => {
    expect(deadlineInstant("2026-10-08")).toBe(at("2026-10-08T00:00:00-06:00"));
    expect(deadlineInstant("2026-10-09T01:00:00Z")).toBe(at("2026-10-09T01:00:00Z"));
    expect(deadlineInstant("garbage")).toBeNaN();
  });

  it("counts days in the device zone", () => {
    expect(formatDeadline("2026-10-08", now)).toBe("due today");
    // 01:00 UTC on the 9th is still the evening of the 8th in Edmonton.
    expect(formatDeadline("2026-10-09T01:00:00Z", now)).toBe("due today");
    expect(formatDeadline("2026-10-09", now)).toBe("due tomorrow");
    expect(formatDeadline("2026-10-20", now)).toMatch(/^due .*20/);
    expect(formatDeadline("2026-10-07", now)).toBe("overdue");
    expect(formatDeadline("garbage", now)).toBe("");
  });

  it("starts a date-only deadline at local midnight across a DST change", () => {
    // Clocks go forward on 2026-03-08, so that day starts at -07:00 and the next at -06:00.
    // (tzdata 2026c keeps Alberta on -06:00 after November 2026, so no fall-back case.)
    expect(deadlineInstant("2026-03-08")).toBe(at("2026-03-08T00:00:00-07:00"));
    expect(deadlineInstant("2026-03-09")).toBe(at("2026-03-09T00:00:00-06:00"));
    expect(formatDeadline("2026-03-09", at("2026-03-08T23:30:00-06:00"))).toBe("due tomorrow");
  });
});

describe("formatLocalIso", () => {
  it("writes the device offset instead of Z, through DST", () => {
    expect(formatLocalIso(at("2026-10-10T17:37:59.000Z"))).toBe("2026-10-10T11:37:59-06:00");
    expect(formatLocalIso(at("2026-03-01T17:37:59.000Z"))).toBe("2026-03-01T10:37:59-07:00");
  });
});

describe("formatInDeviceZone", () => {
  it("adds the schedule zone only when its wall clock differs", () => {
    const nine = at("2026-10-10T09:00:00Z");
    expect(formatInDeviceZone(nine)).toBe("03:00 MDT");
    expect(formatInDeviceZone(nine, "UTC")).toBe("03:00 MDT (09:00 UTC)");
    expect(formatInDeviceZone(nine, "America/Edmonton")).toBe("03:00 MDT");
    expect(formatInDeviceZone(at("2026-03-01T09:00:00Z"), "UTC")).toBe("02:00 MST (09:00 UTC)");
  });
});
