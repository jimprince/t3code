import type { HarnessSnapshot } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { selectHarnessQueuedSends } from "./harnessQuery.ts";

function snapshot(
  environmentId: string,
  count = 2,
  oldest = "2026-10-11T05:00:00.000Z",
): HarnessSnapshot {
  return {
    schemaVersion: 1,
    environmentId: EnvironmentId.make(environmentId),
    generatedAt: "2026-10-11T06:00:00.000Z",
    sources: [],
    agents: [],
    routines: [],
    queueSummary: {
      queuedSendCount: count,
      oldestQueuedRequestedAt: count ? oldest : null,
      coverage: "complete",
      readAt: "2026-10-11T06:00:00.000Z",
      sampleSize: count,
      evidence: "All environment threads.",
    },
  };
}

describe("environment queue selection", () => {
  it("sums complete environment totals and chooses the oldest request", () => {
    expect(
      selectHarnessQueuedSends([
        snapshot("one", 2),
        snapshot("two", 3, "2026-10-11T04:00:00.000Z"),
      ]),
    ).toEqual({ count: 5, oldestRequestedAt: "2026-10-11T04:00:00.000Z" });
    expect(selectHarnessQueuedSends([snapshot("empty", 0)])).toEqual({
      count: 0,
      oldestRequestedAt: null,
    });
  });
  it("counts only the latest snapshot for each environment", () => {
    const older = { ...snapshot("one", 9), generatedAt: "2026-10-11T05:00:00.000Z" };
    expect(selectHarnessQueuedSends([snapshot("one", 2), older])).toEqual({
      count: 2,
      oldestRequestedAt: "2026-10-11T05:00:00.000Z",
    });
  });
  it("does not turn missing or incomplete reads into a known zero", () => {
    const oldHost: HarnessSnapshot = {
      schemaVersion: 1,
      environmentId: EnvironmentId.make("old"),
      generatedAt: "2026-10-11T06:00:00.000Z",
      sources: [],
      agents: [],
      routines: [],
    };
    expect(selectHarnessQueuedSends([])).toBeNull();
    expect(selectHarnessQueuedSends([snapshot("good"), oldHost])).toBeNull();
    for (const coverage of ["partial", "unknown"] as const) {
      const base = snapshot("incomplete");
      const incomplete: HarnessSnapshot = {
        ...base,
        queueSummary: {
          ...base.queueSummary!,
          coverage,
          queuedSendCount: null,
          oldestQueuedRequestedAt: null,
        },
      };
      expect(selectHarnessQueuedSends([snapshot("good"), incomplete])).toBeNull();
    }
  });
});
