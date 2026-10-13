import type { HarnessRoutine, HarnessRun, HarnessSnapshot } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeFindingsLine,
  harnessCheckRef,
  resolveHarnessCheckPage,
  type HarnessEnvironmentRead,
} from "./harnessCheckPage.ts";
import { buildHarnessChecks } from "./harnessView.ts";

const environmentId = EnvironmentId.make("env");
const otherEnvironmentId = EnvironmentId.make("other");
const NOW = Date.parse("2026-10-10T19:41:00.000Z");
const ZONE = { deviceZone: "America/Edmonton" } as const;

function run(overrides: Partial<HarnessRun> = {}): HarnessRun {
  return {
    key: "run-1",
    expectedAt: null,
    requestedAt: "2026-10-10T19:40:00.000Z",
    startedAt: "2026-10-10T19:40:01.000Z",
    finishedAt: "2026-10-10T19:40:30.000Z",
    outcome: "completed",
    outcomeKind: "execution",
    dryRun: false,
    errorCount: null,
    runtimeErrorCount: null,
    evidence: "Turn completed.",
    threads: [],
    ...overrides,
  };
}

const NO_TREND = { sampleSize: 0, knownSamples: 0, missingSamples: 0, average: null, recent: [] };

function routine(overrides: Partial<HarnessRoutine> = {}): HarnessRoutine {
  const history = overrides.history ?? [run()];
  return {
    key: "env:automation:a",
    agentKey: null,
    name: "Staff check",
    whatItChecks: "Reads the queue.",
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
    lifecycle: "standing",
    context: "persistent",
    scheduleOrTrigger: JSON.stringify([
      {
        type: "schedule",
        schedule: { kind: "daily", time: "01:00", timeZone: "America/Edmonton" },
      },
    ]),
    nextExpectedRun: "2026-10-11T07:00:00.000Z",
    lateness: {
      state: "on-time",
      overdue: false,
      since: null,
      latenessMs: null,
      graceMs: 0,
      missedSlots: 0,
      sampleSize: 1,
      coverage: "bounded",
      evidence: "1 expected slots inspected.",
    },
    liveness: "unknown",
    lastRun: history[0] ?? null,
    activeRuns: [],
    history,
    historyCoverage: { retainedFrom: null, truncated: false, evidence: "" },
    errorsPerRun: NO_TREND,
    runtimeErrorsPerRun: NO_TREND,
    failedExecutions: { sampleSize: 1, failures: 0, rate: 0 },
    latestOutput: null,
    ...overrides,
  };
}

const snapshot = (routines: ReadonlyArray<HarnessRoutine>): HarnessSnapshot => ({
  schemaVersion: 1,
  environmentId,
  generatedAt: "2026-10-10T19:41:00.000Z",
  sources: [],
  agents: [],
  routines,
});

const read = (overrides: Partial<HarnessEnvironmentRead> = {}): HarnessEnvironmentRead => ({
  environmentId,
  label: "dev-vm",
  snapshot: snapshot([routine()]),
  error: null,
  ...overrides,
});

const KNOWN = { sampleSize: 3, knownSamples: 3, missingSamples: 0, average: 1, recent: [1, 1, 1] };

describe("resolveHarnessCheckPage", () => {
  it("finds a check by the environment and key its snapshot gave it", () => {
    const [check] = buildHarnessChecks([snapshot([routine()])], NOW, ZONE);
    const ref = harnessCheckRef(check!);
    expect(ref).toEqual({ environmentId, checkKey: "env:automation:a" });
    const state = resolveHarnessCheckPage([read()], ref, NOW, ZONE);
    expect(state.kind).toBe("found");
    if (state.kind !== "found") return;
    expect(state.page.check.name).toBe("Staff check");
    expect(state.page.runs.map((entry) => entry.key)).toEqual(["run-1"]);
    expect(state.page.facts.find((fact) => fact.label === "Schedule")?.value).toBe("Daily 01:00");
  });

  it("keeps an awkward key whole and scopes it to its environment", () => {
    const key = "env:thread:delegated-task:command%3Amcp%3Aabc/def?x=1#y";
    const checkRef = { environmentId, checkKey: key };
    const environments = [
      read({ snapshot: snapshot([routine({ key })]) }),
      read({ environmentId: otherEnvironmentId, label: "mbp", snapshot: snapshot([]) }),
    ];
    expect(resolveHarnessCheckPage(environments, checkRef, NOW, ZONE).kind).toBe("found");
    // The same key under another server is a different (missing) check.
    expect(
      resolveHarnessCheckPage(
        environments,
        { ...checkRef, environmentId: otherEnvironmentId },
        NOW,
        ZONE,
      ).kind,
    ).toBe("not-found");
  });

  it("says a missing check, or one on a server that is not connected, is not found", () => {
    const missing = resolveHarnessCheckPage(
      [read()],
      { environmentId, checkKey: "env:automation:gone" },
      NOW,
      ZONE,
    );
    expect(missing).toMatchObject({ kind: "not-found" });
    expect(missing.kind === "not-found" && missing.message).toMatch(/not found/i);
    expect(
      resolveHarnessCheckPage([], { environmentId, checkKey: "env:automation:a" }, NOW, ZONE).kind,
    ).toBe("not-found");
  });

  it("is loading until the server answers, and an error when it fails before any read", () => {
    const ref = { environmentId, checkKey: "env:automation:a" };
    expect(
      resolveHarnessCheckPage([read({ snapshot: null, isPending: true })], ref, NOW, ZONE).kind,
    ).toBe("loading");
    expect(
      resolveHarnessCheckPage([read({ snapshot: null, error: "offline" })], ref, NOW, ZONE),
    ).toMatchObject({ kind: "error", message: expect.stringContaining("offline") });
  });

  it("keeps the last read when a refresh fails, marked stale, and never says healthy", () => {
    const ref = { environmentId, checkKey: "env:automation:a" };
    const state = resolveHarnessCheckPage([read({ error: "timeout" })], ref, NOW, ZONE);
    expect(state.kind).toBe("found");
    if (state.kind !== "found") return;
    expect(state.page.readError).toBe("timeout");
    expect(state.page.check.state).toBe("source-stale");
    expect(state.page.check.tone).not.toBe("ok");
  });

  it("lists findings only once a run has reported a count, and never as zero", () => {
    const ref = { environmentId, checkKey: "env:automation:a" };
    const unknown = resolveHarnessCheckPage([read()], ref, NOW, ZONE);
    expect(unknown.kind === "found" && unknown.page.facts.map((fact) => fact.label)).toEqual([
      "Schedule",
      "Last run",
      "Next expected",
      "Failed runs",
    ]);
    expect(unknown.kind === "found" && unknown.page.facts.map((fact) => fact.label)).not.toContain(
      "Findings per run",
    );
    const known = resolveHarnessCheckPage(
      [read({ snapshot: snapshot([routine({ errorsPerRun: KNOWN })]) })],
      ref,
      NOW,
      ZONE,
    );
    expect(
      known.kind === "found" && known.page.facts.find((fact) => fact.label === "Findings per run"),
    ).toEqual({ label: "Findings per run", value: "1 / run (1 1 1)" });
  });
});

describe("describeFindingsLine", () => {
  it("is null when no run reported a count and shows the count otherwise", () => {
    const [unknown, known] = buildHarnessChecks(
      [
        snapshot([
          routine({ key: "a" }),
          routine({ key: "b", errorsPerRun: { ...KNOWN, average: 0, recent: [0, 0, 0] } }),
        ]),
      ],
      NOW,
      ZONE,
    );
    const lines = [unknown, known].map((check) => describeFindingsLine(check!));
    expect(lines).toContain(null);
    // A reported zero is a real zero, shown as one.
    expect(lines).toContain("0 / run (0 0 0)");
  });
});
