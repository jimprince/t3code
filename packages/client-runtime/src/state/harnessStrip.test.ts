import type { HarnessRoutine, HarnessRun, HarnessSnapshot } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { selectHarnessQueuedSends } from "./harnessQuery.ts";
import { buildHarnessStrip, HARNESS_QUEUE_WAIT_WARN_MS } from "./harnessStrip.ts";

const environmentId = EnvironmentId.make("env");
const at = (value: string) => Date.parse(value);
const NOW = at("2026-10-10T19:41:00Z");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const minutesAgo = (minutes: number) => iso(NOW - minutes * 60_000);

function run(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    key: "run",
    expectedAt: null,
    requestedAt: minutesAgo(30),
    startedAt: minutesAgo(30),
    finishedAt: minutesAgo(29),
    outcome: "completed",
    outcomeKind: "execution",
    dryRun: false,
    errorCount: null,
    runtimeErrorCount: null,
    evidence: "",
    threads: [],
    ...overrides,
  };
}

const NO_TREND = { sampleSize: 0, knownSamples: 0, missingSamples: 0, average: null, recent: [] };
let counter = 0;
function routine(overrides: Partial<HarnessRoutine> = {}): HarnessRoutine {
  counter += 1;
  return {
    key: `r${counter}`,
    agentKey: null,
    name: `Check ${counter}`,
    whatItChecks: null,
    environmentId,
    projectId: null,
    owner: null,
    purpose: "harness",
    routineKind: "check",
    routineKindSource: "default",
    ownerThreadId: null,
    source: "automations",
    sourceStale: false,
    state: "enabled",
    lifecycle: "conditional",
    context: "new-instance-per-run",
    scheduleOrTrigger: "every 30 min",
    nextExpectedRun: null,
    lateness: {
      state: "on-time",
      overdue: false,
      since: null,
      latenessMs: null,
      graceMs: 0,
      missedSlots: 0,
      sampleSize: 1,
      coverage: "bounded",
      evidence: "",
    },
    liveness: "not currently live",
    lastRun: null,
    activeRuns: [],
    history: [],
    historyCoverage: { retainedFrom: null, truncated: false, evidence: "" },
    errorsPerRun: NO_TREND,
    runtimeErrorsPerRun: NO_TREND,
    failedExecutions: { sampleSize: 0, failures: 0, rate: null },
    latestOutput: null,
    ...overrides,
  };
}

const snapshot = (
  routines: ReadonlyArray<HarnessRoutine>,
  generatedAt = iso(NOW),
): HarnessSnapshot => ({
  schemaVersion: 1,
  environmentId,
  generatedAt,
  sources: [],
  agents: [],
  routines,
});

const queued = (key: string, waitMinutes: number) =>
  run({
    key,
    outcome: "queued",
    startedAt: null,
    finishedAt: null,
    requestedAt: minutesAgo(waitMinutes),
  });
const failed = (key: string, hoursAgo: number) =>
  run({
    key,
    outcome: "failed",
    requestedAt: iso(NOW - hoursAgo * 3_600_000),
    startedAt: null,
    finishedAt: iso(NOW - hoursAgo * 3_600_000),
  });
const strip = (
  routines: HarnessRoutine[],
  extra: Partial<Parameters<typeof buildHarnessStrip>[0]> = {},
) => buildHarnessStrip({ snapshots: [snapshot(routines)], now: NOW, ...extra });

describe("buildHarnessStrip", () => {
  it("uses complete environment queue data once, including automations and ordinary sends", () => {
    const read: HarnessSnapshot = {
      ...snapshot([routine({ activeRuns: [queued("automation", 9)] })]),
      queueSummary: {
        queuedSendCount: 3,
        oldestQueuedRequestedAt: minutesAgo(12),
        coverage: "complete",
        readAt: iso(NOW),
        sampleSize: 3,
        evidence: "All environment threads including automation execution.",
      },
    };
    expect(
      buildHarnessStrip({
        snapshots: [read],
        now: NOW,
        queuedSends: selectHarnessQueuedSends([read]),
      }).text,
    ).toBe("Queue 3 · Oldest wait 12m · Failed 24h 0");
    // Separately read routine rows may still show a queue that has already drained.
    const drained: HarnessSnapshot = {
      ...read,
      queueSummary: {
        ...read.queueSummary!,
        queuedSendCount: 0,
        oldestQueuedRequestedAt: null,
        sampleSize: 0,
      },
    };
    expect(
      buildHarnessStrip({
        snapshots: [drained],
        now: NOW,
        queuedSends: selectHarnessQueuedSends([drained]),
      }).text,
    ).toBe("Queue 0 · Oldest wait none · Failed 24h 0");
  });

  it("keeps sends unknown for partial reads and hosts without the queue field", () => {
    const read = snapshot([routine({ activeRuns: [queued("automation", 9)] })]);
    for (const coverage of ["partial", "unknown"] as const) {
      const incomplete: HarnessSnapshot = {
        ...read,
        queueSummary: {
          queuedSendCount: null,
          oldestQueuedRequestedAt: null,
          coverage,
          readAt: iso(NOW),
          sampleSize: 0,
          evidence: "Cannot prove the total.",
        },
      };
      expect(
        buildHarnessStrip({
          snapshots: [incomplete],
          now: NOW,
          queuedSends: selectHarnessQueuedSends([incomplete]),
        }).parts.map((part) => part.value),
      ).toEqual(["1 run, sends unknown", "9m+", "0"]);
    }
    expect(
      buildHarnessStrip({
        snapshots: [read],
        now: NOW,
        queuedSends: selectHarnessQueuedSends([read]),
      }).parts[0]?.value,
    ).toBe("1 run, sends unknown");
  });

  it("counts queued automation runs, the oldest wait and 24 h failures on one plain line", () => {
    const result = strip(
      [
        routine({ activeRuns: [queued("a", 9), queued("b", 3)] }),
        routine({ history: [failed("c", 2), failed("d", 30), failed("e", 23)] }),
      ],
      { queuedSends: { count: 4, oldestRequestedAt: minutesAgo(9) } },
    );
    expect(result.text).toBe("Queue 4 · Oldest wait 9m · Failed 24h 2");
    expect(result.stale).toBe(false);
  });

  it("says sends unknown, and a floor on the wait, while the client cannot read thread sends", () => {
    const result = strip([routine({ activeRuns: [queued("a", 9)] })]);
    expect(result.parts.map((part) => part.value)).toEqual(["1 run, sends unknown", "9m+", "0"]);
  });

  it("never turns missing data into zero", () => {
    expect(buildHarnessStrip({ snapshots: [], now: NOW }).text).toBe(
      "Queue unknown · Oldest wait unknown · Failed 24h unknown",
    );
    // Nothing queued among the runs is not "no wait" while sends cannot be read.
    expect(strip([routine()]).parts[1]?.value).toBe("unknown");
    // With sends readable and none queued, none is a real answer.
    expect(strip([routine()], { queuedSends: { count: 0, oldestRequestedAt: null } }).text).toBe(
      "Queue 0 · Oldest wait none · Failed 24h 0",
    );
  });

  it("counts a failure once per run and ignores dry runs, dispatch rows and other windows", () => {
    const result = strip(
      [
        routine({
          history: [
            failed("a", 1),
            run({ ...failed("b", 1), dryRun: true }),
            run({ ...failed("c", 1), outcomeKind: "dispatch" }),
            failed("d", 25),
          ],
        }),
      ],
      { queuedSends: { count: 0, oldestRequestedAt: null } },
    );
    expect(result.parts[2]?.value).toBe("1");
  });

  it("does not undercount a bounded history: at least N, or unknown at zero", () => {
    const truncated = { retainedFrom: minutesAgo(60), truncated: true, evidence: "" };
    const some = strip([routine({ history: [failed("a", 0.5)], historyCoverage: truncated })]);
    expect(some.parts[2]?.value).toBe("at least 1");
    const none = strip([routine({ history: [], historyCoverage: truncated })]);
    expect(none.parts[2]?.value).toBe("unknown");
    // Retained history reaches past the window start, so the count is exact.
    const exact = strip([
      routine({
        history: [failed("a", 0.5)],
        historyCoverage: {
          retainedFrom: iso(NOW - 48 * 3_600_000),
          truncated: true,
          evidence: "",
        },
      }),
    ]);
    expect(exact.parts[2]?.value).toBe("1");
  });

  it("marks an environment that has not answered as a lower bound", () => {
    const result = strip([routine({ activeRuns: [queued("a", 2)] })], { missingEnvironments: 1 });
    expect(result.parts[0]?.value).toBe("at least 1 run, sends unknown");
    expect(result.stale).toBe(true);
  });

  it("leaves ownerless routines out of the Harness strip", () => {
    const result = strip([
      routine({
        purpose: "unclassified",
        activeRuns: [queued("a", 20)],
        history: [failed("b", 1)],
      }),
    ]);
    expect(result.parts.map((part) => part.value)).toEqual([
      "0 runs, sends unknown",
      "unknown",
      "0",
    ]);
  });

  it("is amber only once the wait passes the threshold, red for failures, never green", () => {
    const limit = HARNESS_QUEUE_WAIT_WARN_MS / 60_000;
    const under = strip([routine({ activeRuns: [queued("a", limit - 1)] })]);
    const over = strip([routine({ activeRuns: [queued("a", limit)], history: [failed("b", 1)] })]);
    expect(under.parts.map((part) => part.tone)).toEqual(["muted", "muted", "muted"]);
    expect(over.parts.map((part) => part.tone)).toEqual(["muted", "warning", "error"]);
    expect(over.parts.some((part) => part.tone === "ok")).toBe(false);
  });

  it("dims and marks the strip stale when the read is old or the host is not answering", () => {
    const old = buildHarnessStrip({
      snapshots: [snapshot([routine()], minutesAgo(10))],
      now: NOW,
    });
    expect(old.stale).toBe(true);
    expect(old.text.endsWith("· stale")).toBe(true);
    expect(strip([routine()], { unreachable: new Set([environmentId]) }).stale).toBe(true);
    expect(strip([routine()]).stale).toBe(false);
  });
});
