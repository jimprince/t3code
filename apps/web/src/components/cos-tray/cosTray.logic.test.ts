import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatLastReply, selectChiefOfStaffThread, toggleCosTray } from "./cosTray.logic";

const env = "env-1" as EnvironmentId;
const thread = (id: string, title: string, archivedAt: string | null = null) => ({
  environmentId: env,
  id: id as ThreadId,
  title,
  archivedAt,
});

describe("toggleCosTray", () => {
  it("opens from closed and minimized, closes from open", () => {
    expect(toggleCosTray("closed")).toBe("open");
    expect(toggleCosTray("minimized")).toBe("open");
    expect(toggleCosTray("open")).toBe("closed");
  });
  it("on a phone follows the sheet: a stored open mode with the sheet closed opens it", () => {
    expect(toggleCosTray("open", { sheetOpen: false })).toBe("open");
    expect(toggleCosTray("minimized", { sheetOpen: false })).toBe("open");
    expect(toggleCosTray("open", { sheetOpen: true })).toBe("closed");
  });
});

describe("formatLastReply", () => {
  const now = new Date(2026, 9, 12, 14, 0);
  it("shows only the time for today", () => {
    expect(formatLastReply(new Date(2026, 9, 12, 13, 55).toISOString(), now)).toBe("13:55");
  });
  it("leads with the weekday for an earlier day", () => {
    expect(formatLastReply(new Date(2026, 9, 9, 17, 30).toISOString(), now)).toMatch(/\S+ 17:30$/);
  });
  it("is empty for an unreadable instant", () => {
    expect(formatLastReply("not a date", now)).toBe("");
  });
});

describe("selectChiefOfStaffThread", () => {
  const threads = [
    thread("ops", "chief-of-staff Operations"),
    thread("old", "Chief of Staff", "2026-10-01T00:00:00Z"),
    thread("desk", "Chief of Staff"),
  ];
  it("finds the front desk by exact title in the primary environment", () => {
    expect(
      selectChiefOfStaffThread({ threads, preferred: null, primaryEnvironmentId: env }),
    ).toEqual({ environmentId: env, threadId: "desk" });
  });
  it("never picks Operations by name", () => {
    expect(
      selectChiefOfStaffThread({
        threads: [thread("ops", "chief-of-staff Operations")],
        preferred: null,
        primaryEnvironmentId: env,
      }),
    ).toBeNull();
  });
  it("follows the preference, and a missing or archived preferred thread means no tray", () => {
    const preferred = (id: string) => ({ environmentId: env, threadId: id as ThreadId });
    expect(
      selectChiefOfStaffThread({ threads, preferred: preferred("ops"), primaryEnvironmentId: env }),
    ).toEqual({ environmentId: env, threadId: "ops" });
    expect(
      selectChiefOfStaffThread({ threads, preferred: preferred("old"), primaryEnvironmentId: env }),
    ).toBeNull();
    expect(
      selectChiefOfStaffThread({
        threads,
        preferred: preferred("gone"),
        primaryEnvironmentId: env,
      }),
    ).toBeNull();
  });
});
