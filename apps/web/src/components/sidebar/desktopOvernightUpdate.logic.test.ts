import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isOvernight, resolveOvernightUpdateStep } from "./desktopOvernightUpdate.logic";

const at = (hour: number, minute = 0) => new Date(2026, 8, 27, hour, minute);
const available = {
  enabled: true,
  status: "available",
  availableVersion: "1.1.0",
  downloadedVersion: null,
} as DesktopUpdateState;
const downloaded = {
  enabled: true,
  status: "downloaded",
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  errorContext: null,
} as DesktopUpdateState;
const idle = { now: at(2), userQuiet: true, busyAgentCount: 0, attempted: new Set<string>() };

describe("isOvernight", () => {
  it("covers 01:00 up to but not including 06:00 local time", () => {
    expect(isOvernight(at(0, 59))).toBe(false);
    expect(isOvernight(at(1))).toBe(true);
    expect(isOvernight(at(5, 59))).toBe(true);
    expect(isOvernight(at(6))).toBe(false);
  });
});

describe("resolveOvernightUpdateStep", () => {
  it("downloads an available update even while agents work", () => {
    expect(
      resolveOvernightUpdateStep({
        ...idle,
        state: available,
        userQuiet: false,
        busyAgentCount: 2,
      }),
    ).toEqual({ type: "download", key: "download 1.1.0 2026-9-27" });
  });

  it("installs a downloaded update only when agents and the user are idle", () => {
    expect(resolveOvernightUpdateStep({ ...idle, state: downloaded })).toEqual({
      type: "install",
      key: "install 1.1.0 2026-9-27",
    });
    expect(resolveOvernightUpdateStep({ ...idle, state: downloaded, busyAgentCount: 1 })).toEqual({
      type: "wait",
    });
    expect(resolveOvernightUpdateStep({ ...idle, state: downloaded, userQuiet: false })).toEqual({
      type: "wait",
    });
  });

  it("does nothing during the day or when updates are disabled", () => {
    expect(resolveOvernightUpdateStep({ ...idle, state: downloaded, now: at(14) })).toEqual({
      type: "wait",
    });
    expect(
      resolveOvernightUpdateStep({ ...idle, state: { ...downloaded, enabled: false } }),
    ).toEqual({ type: "wait" });
    expect(resolveOvernightUpdateStep({ ...idle, state: null })).toEqual({ type: "wait" });
  });

  it("tries each step once per night, then again the next night", () => {
    const attempted = new Set(["install 1.1.0 2026-9-27"]);
    expect(resolveOvernightUpdateStep({ ...idle, state: downloaded, attempted })).toEqual({
      type: "wait",
    });
    expect(
      resolveOvernightUpdateStep({
        ...idle,
        state: downloaded,
        attempted,
        now: new Date(2026, 8, 28, 2),
      }),
    ).toEqual({ type: "install", key: "install 1.1.0 2026-9-28" });
  });
});
