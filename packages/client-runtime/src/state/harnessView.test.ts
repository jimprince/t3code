import type { HarnessRoutine, HarnessRun, HarnessSnapshot } from "@t3tools/contracts";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHarnessAgents,
  buildHarnessChecks,
  buildHarnessRunRows,
  classifyHarnessCheck,
  describeHarnessAgent,
  describeHarnessFreshness,
  staleHarnessSources,
} from "./harnessView.ts";
import { presentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  buildOrchestratorSummaries,
  threadsVisibleInThreadsMode,
  type OrchestratorThreadShell,
} from "./orchestrators.ts";
import { partitionThreadPurposes } from "./threadPurpose.ts";

beforeAll(() => {
  vi.stubEnv("TZ", "America/Edmonton");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const environmentId = EnvironmentId.make("env");
const at = (value: string) => Date.parse(value);
// Saturday 2026-10-10 13:41 in Calgary.
const NOW = at("2026-10-10T13:41:00-06:00");

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
    whatItChecks: null,
    environmentId,
    projectId: null,
    owner: null,
    purpose: "harness",
    source: "automations",
    sourceStale: false,
    state: "enabled",
    lifecycle: "conditional",
    context: "new-instance-per-run",
    scheduleOrTrigger: "every 30 min",
    nextExpectedRun: "2026-10-10T20:10:00.000Z",
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
    liveness: "not currently live",
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

const snapshot = (
  routines: ReadonlyArray<HarnessRoutine>,
  overrides: Partial<HarnessSnapshot> = {},
): HarnessSnapshot => ({
  schemaVersion: 1,
  environmentId,
  generatedAt: "2026-10-10T19:41:00.000Z",
  sources: [],
  agents: [],
  routines,
  ...overrides,
});

const stateOf = (overrides: Partial<HarnessRoutine>) =>
  classifyHarnessCheck(routine(overrides)).state;

describe("classifyHarnessCheck", () => {
  it("earns healthy from a finished execution that completed on schedule", () => {
    expect(stateOf({})).toBe("healthy");
    expect(
      stateOf({
        lateness: { ...routine().lateness, state: "event-driven", overdue: null },
      }),
    ).toBe("healthy");
  });

  it("never reads disabled, not shown yet or stale sources as healthy", () => {
    // Each of these has a perfectly good completed last run behind it.
    expect(stateOf({ state: "disabled" })).toBe("disabled");
    expect(
      stateOf({ lateness: { ...routine().lateness, state: "disabled", overdue: false } }),
    ).toBe("disabled");
    expect(stateOf({ state: "not shown yet" })).toBe("not-shown");
    expect(stateOf({ sourceStale: true })).toBe("source-stale");
  });

  it("calls a check overdue from its lateness evidence, even after a good run", () => {
    const late = routine({
      lateness: { ...routine().lateness, state: "overdue", overdue: true, latenessMs: 1_500_000 },
    });
    expect(classifyHarnessCheck(late).state).toBe("overdue");
  });

  it("calls a failed latest run failing, ahead of overdue", () => {
    expect(
      stateOf({
        history: [run({ outcome: "failed", evidence: "pair timeout" })],
        lateness: { ...routine().lateness, state: "overdue", overdue: true },
      }),
    ).toBe("failing");
    expect(stateOf({ state: "failing" })).toBe("failing");
  });

  it("does not claim healthy without a finished execution, or on dispatch evidence alone", () => {
    expect(stateOf({ history: [], lastRun: null })).toBe("unknown");
    expect(stateOf({ history: [run({ outcomeKind: "dispatch", outcome: "completed" })] })).toBe(
      "unknown",
    );
    expect(stateOf({ history: [run({ outcome: "running", finishedAt: null })] })).toBe("unknown");
    expect(stateOf({ lateness: { ...routine().lateness, state: "unknown", overdue: null } })).toBe(
      "unknown",
    );
    expect(stateOf({ history: [run({ outcome: "interrupted" })] })).toBe("unknown");
  });

  it("judges by the latest finished run while a newer one is still running", () => {
    expect(
      stateOf({
        history: [
          run({ key: "r2", outcome: "running", finishedAt: null }),
          run({ key: "r1", outcome: "failed" }),
        ],
      }),
    ).toBe("failing");
  });
});

describe("buildHarnessChecks", () => {
  it("shows errors per run as unknown, never zero, when no run reported a count", () => {
    const [check] = buildHarnessChecks([snapshot([routine()])], NOW);
    expect(check?.errors).toMatchObject({ known: false, label: "unknown", trend: "" });
  });

  it("shows the average and an oldest-to-newest trend, and flags findings on every run", () => {
    const counts = [4, 3, 2, 1];
    const errorsPerRun = {
      sampleSize: 4,
      knownSamples: 4,
      missingSamples: 0,
      average: 2.5,
      // The snapshot lists newest first.
      recent: counts,
    };
    const [check] = buildHarnessChecks([snapshot([routine({ errorsPerRun })])], NOW);
    expect(check?.errors).toMatchObject({
      known: true,
      label: "2.5 / run",
      trend: "1 2 3 4",
      everyRun: true,
    });
    const mixed = routine({
      errorsPerRun: { ...errorsPerRun, recent: [3, 0, 2], knownSamples: 3, average: 5 / 3 },
    });
    expect(buildHarnessChecks([snapshot([mixed])], NOW)[0]?.errors.everyRun).toBe(false);
  });

  it("marks unreported runs in the trend and does not flag a single sample", () => {
    const errorsPerRun = {
      sampleSize: 3,
      knownSamples: 1,
      missingSamples: 2,
      average: 2,
      recent: [null, null, 2],
    };
    const [check] = buildHarnessChecks([snapshot([routine({ errorsPerRun })])], NOW);
    expect(check?.errors.trend).toBe("2 ? ?");
    expect(check?.errors.everyRun).toBe(false);
  });

  it("sorts failures and overdue checks first, then findings-every-run, healthy last before dormant", () => {
    const healthy = routine({ key: "healthy", name: "Healthy" });
    const noisy = routine({
      key: "noisy",
      name: "Noisy",
      errorsPerRun: {
        sampleSize: 3,
        knownSamples: 3,
        missingSamples: 0,
        average: 2,
        recent: [2, 2, 2],
      },
    });
    const overdue = routine({
      key: "overdue",
      name: "Overdue",
      lateness: {
        ...routine().lateness,
        state: "overdue",
        overdue: true,
        latenessMs: 1_500_000,
        missedSlots: 2,
      },
    });
    const failing = routine({ key: "failing", name: "Failing", state: "failing" });
    const disabled = routine({ key: "disabled", name: "Disabled", state: "disabled" });
    const notShown = routine({ key: "not-shown", name: "Not shown", state: "not shown yet" });
    const unknown = routine({ key: "unknown", name: "Unknown", history: [], lastRun: null });
    const checks = buildHarnessChecks(
      [snapshot([disabled, healthy, notShown, unknown, noisy, overdue, failing])],
      NOW,
    );
    expect(checks.map((check) => check.key)).toEqual([
      "failing",
      "overdue",
      "noisy",
      "unknown",
      "healthy",
      "not-shown",
      "disabled",
    ]);
    expect(checks.find((check) => check.key === "overdue")?.latenessLabel).toBe(
      "Late 25m, 2 missed",
    );
  });

  it("labels a per-run agent between runs and never a persistent one", () => {
    const [perRun, persistent, running] = buildHarnessChecks(
      [
        snapshot([
          routine({ key: "a", name: "A" }),
          routine({ key: "b", name: "B", context: "persistent" }),
          routine({ key: "c", name: "C", liveness: "active" }),
        ]),
      ],
      NOW,
    );
    expect(perRun?.livenessLabel).toBe("Not currently live");
    expect(persistent?.livenessLabel).toBeNull();
    expect(running?.livenessLabel).toBe("Running");
  });

  it("writes times in the device zone: the clock today, weekday and clock earlier, no next when disabled", () => {
    const [check] = buildHarnessChecks(
      [
        snapshot([
          routine({
            history: [
              run({
                finishedAt: "2026-10-09T00:02:00.000Z",
                requestedAt: "2026-10-09T00:00:00.000Z",
              }),
            ],
            nextExpectedRun: "2026-10-10T19:45:00.000Z",
          }),
        ]),
      ],
      NOW,
    );
    expect(check?.lastRunLabel).toBe("Thu 18:02");
    expect(check?.nextLabel).toBe("13:45");
    const [disabled] = buildHarnessChecks(
      [snapshot([routine({ state: "disabled", nextExpectedRun: "2026-10-10T19:45:00.000Z" })])],
      NOW,
    );
    expect(disabled?.nextLabel).toBeNull();
  });
});

describe("buildHarnessRunRows", () => {
  it("lists runs with unknown error counts, a dispatch that does not claim success, and thread links", () => {
    const link = {
      environmentId,
      threadId: ThreadId.make("automation:p:a:1"),
      runId: null,
      messageId: null,
      href: "/env/automation%3Ap%3Aa%3A1",
    };
    const rows = buildHarnessRunRows(
      routine({
        history: [
          run({ key: "r2", outcomeKind: "dispatch", outcome: "completed", threads: [link] }),
          run({ key: "r1", outcome: "failed", errorCount: 3 }),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => [row.outcomeLabel, row.errorsLabel, row.failed])).toEqual([
      ["Dispatched", "unknown", false],
      ["Failed", "3", true],
    ]);
    expect(rows[0]?.thread).toBe(link);
    expect(rows[1]?.thread).toBeNull();
  });
});

describe("snapshot freshness", () => {
  it("doubts a snapshot older than a few refreshes and says when it was read", () => {
    expect(describeHarnessFreshness("2026-10-10T19:40:30.000Z", NOW)).toEqual({
      label: "read 13:40",
      stale: false,
    });
    expect(describeHarnessFreshness("2026-10-10T19:30:00.000Z", NOW).stale).toBe(true);
    expect(describeHarnessFreshness(null, NOW)).toEqual({ label: "not loaded", stale: true });
  });

  it("counts sources that are not available", () => {
    const source = (status: "available" | "stale" | "refused") => ({
      key: status,
      readAt: "2026-10-10T19:41:00.000Z",
      observedAt: null,
      status,
      evidence: "",
    });
    expect(
      staleHarnessSources([
        snapshot([], { sources: [source("available"), source("stale"), source("refused")] }),
      ]),
    ).toBe(2);
  });
});

describe("the three sidebar modes", () => {
  const shell = (
    id: string,
    parentThreadId: string | null,
    extra: Partial<OrchestratorThreadShell> = {},
  ): OrchestratorThreadShell => ({
    ...presentThreadShell(environmentId, {
      ...v2ThreadShell,
      id: ThreadId.make(id),
      title: id,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pendingBackgroundTasks: [],
    }),
    runtime: null,
    latestRun: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    parentThreadId: parentThreadId === null ? null : ThreadId.make(parentThreadId),
    ...extra,
  });
  const running = (status: "running" | "failed") => ({
    status,
    activeRunId: null,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerName: "codex",
    updatedAt: "2026-10-10T19:40:00.000Z",
    lastError: null,
  });
  const threads = [
    shell("project-root", null),
    shell("project-worker", "project-root"),
    shell("harness-root", null, { purpose: "harness" }),
    shell("harness-worker", "harness-root", { hasPendingApprovals: true }),
    shell("harness-blocked", null, { purpose: "harness" }),
    shell("blocked-worker", "harness-blocked", { runtime: running("failed") }),
    shell("harness-failed", null, { purpose: "harness", runtime: running("failed") }),
    shell("harness-working", null, { purpose: "harness", runtime: running("running") }),
    shell("harness-idle", null, { purpose: "harness" }),
    shell("plain", null),
  ];

  it("puts every thread in exactly one of Threads, Projects and Harness", () => {
    const summaries = buildOrchestratorSummaries(threads, []);
    const partition = partitionThreadPurposes(threads, summaries);
    const idOf = (entry: { root: { id: string } } | { id: string }) =>
      "root" in entry ? entry.root.id : entry.id;
    expect(threadsVisibleInThreadsMode(threads, true).map((thread) => thread.id)).toEqual([
      "plain",
    ]);
    expect(partition.projects.map(idOf)).toEqual(["project-root"]);
    expect(partition.harness.map(idOf).toSorted()).toEqual([
      "harness-blocked",
      "harness-failed",
      "harness-idle",
      "harness-root",
      "harness-working",
    ]);
  });

  it("orders Harness agents failed, needs you, working, then idle, with the idle ones foldable", () => {
    const partition = partitionThreadPurposes(threads, buildOrchestratorSummaries(threads, []));
    const agents = buildHarnessAgents(partition.harness);
    expect(agents.map((agent) => [agent.thread.id, agent.bucket])).toEqual([
      ["harness-blocked", "failed"],
      ["harness-failed", "failed"],
      ["harness-root", "needs-you"],
      ["harness-working", "working"],
      ["harness-idle", "idle"],
    ]);
    expect(agents[2]?.needsYou).toBe(1);
    expect(agents.map((agent) => describeHarnessAgent(agent)?.text ?? null)).toEqual([
      "1 blocked",
      "failed",
      "1 needs you",
      "working",
      null,
    ]);
  });
});
