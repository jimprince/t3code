import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  formatWorkerCount,
  supervisionWorkerDuration,
  supervisionWorkerStatus,
} from "./supervisionWorkerRow.logic";

type StatusInput = Parameters<typeof supervisionWorkerStatus>[0];
const base: StatusInput = {
  settledOverride: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  runtime: null,
  latestRun: null,
};
const run = (status: NonNullable<EnvironmentThreadShell["latestRun"]>["status"]) =>
  ({ ...base, latestRun: { status } as EnvironmentThreadShell["latestRun"] }) as StatusInput;

describe("supervisionWorkerStatus", () => {
  it("lets a settled override and pending questions outrank the run state", () => {
    expect(supervisionWorkerStatus({ ...base, settledOverride: "settled" })).toBe("settled");
    expect(supervisionWorkerStatus({ ...base, hasPendingApprovals: true })).toBe("approval");
    expect(supervisionWorkerStatus({ ...base, hasPendingUserInput: true })).toBe("input");
  });

  it("maps the latest run when nothing is live", () => {
    expect(supervisionWorkerStatus(run("completed"))).toBe("completed");
    expect(supervisionWorkerStatus(run("failed"))).toBe("error");
    expect(supervisionWorkerStatus(run("interrupted"))).toBe("interrupted");
    expect(supervisionWorkerStatus(base)).toBe("ready");
  });
});

describe("supervisionWorkerDuration", () => {
  const at = (startedAt: string, completedAt: string | null) =>
    ({
      latestRun: { startedAt, requestedAt: null, completedAt },
    }) as Pick<EnvironmentThreadShell, "latestRun">;

  it("formats seconds, minutes and hours, running against the supplied clock", () => {
    expect(supervisionWorkerDuration(at("2026-01-01T00:00:00Z", "2026-01-01T00:00:42Z"), "")).toBe(
      "42s",
    );
    expect(supervisionWorkerDuration(at("2026-01-01T00:00:00Z", "2026-01-01T00:03:05Z"), "")).toBe(
      "3m 05s",
    );
    expect(
      supervisionWorkerDuration(at("2026-01-01T00:00:00Z", null), "2026-01-01T02:07:00Z"),
    ).toBe("2h 07m");
  });

  it("is empty without a run", () => {
    expect(supervisionWorkerDuration({ latestRun: null }, "2026-01-01T00:00:00Z")).toBe("");
  });
});

describe("formatWorkerCount", () => {
  it("uses real plurals and compact thousands", () => {
    expect(formatWorkerCount(1, "tool")).toBe("1 tool");
    expect(formatWorkerCount(3, "tool")).toBe("3 tools");
    expect(formatWorkerCount(12400, "token")).toBe("12.4K tokens");
  });
});
