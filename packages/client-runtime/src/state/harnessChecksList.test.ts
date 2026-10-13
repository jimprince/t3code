import type { HarnessRoutine, HarnessRun, HarnessSnapshot } from "@t3tools/contracts";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHarnessChecksList,
  harnessOwnerTitles,
  isHarnessFeedRow,
  matchesHarnessCheckQuery,
} from "./harnessChecksList.ts";
import { buildHarnessChecks } from "./harnessView.ts";

const environmentId = EnvironmentId.make("env");
const NOW = Date.parse("2026-10-13T12:00:00.000Z");
const ZONE = { deviceZone: "America/Edmonton" } as const;

const run = (overrides: Partial<HarnessRun> = {}): HarnessRun => ({
  key: "run-1",
  expectedAt: null,
  requestedAt: "2026-10-13T11:50:00.000Z",
  startedAt: "2026-10-13T11:50:01.000Z",
  finishedAt: "2026-10-13T11:50:30.000Z",
  outcome: "completed",
  outcomeKind: "execution",
  dryRun: false,
  errorCount: null,
  runtimeErrorCount: null,
  evidence: "Turn completed.",
  threads: [],
  ...overrides,
});
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
    lifecycle: "standing",
    context: "persistent",
    scheduleOrTrigger: "every 30 min",
    nextExpectedRun: "2026-10-13T12:10:00.000Z",
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
    failedExecutions: { sampleSize: history.length, failures: 0, rate: 0 },
    latestOutput: null,
    ...overrides,
  };
}

const snapshot = (routines: ReadonlyArray<HarnessRoutine>): HarnessSnapshot => ({
  schemaVersion: 1,
  environmentId,
  generatedAt: "2026-10-13T11:59:00.000Z",
  sources: [],
  agents: [],
  routines,
});

/** Feed rows as the server emits them: not set up, or set up with a source that went stale. */
const notShownFeed = (key: string, name: string) =>
  routine({
    key,
    name,
    state: "not shown yet",
    sourceStale: true,
    history: [],
    lastRun: null,
    nextExpectedRun: null,
    scheduleOrTrigger: "Not shown yet: no typed owner execution receipt",
  });
const staleFeed = (key: string, name: string) =>
  routine({
    key,
    name,
    state: "unknown",
    sourceStale: true,
    scheduleOrTrigger: "Owner feed; no typed unconditional schedule receipt",
  });

const owner = {
  environmentId,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  messageId: null,
  href: "",
};

function fixture() {
  return buildHarnessChecks(
    [
      snapshot([
        routine({
          key: "env:automation:failing",
          name: "Release canary",
          state: "failing",
          history: [run({ outcome: "failed" })],
        }),
        routine({
          key: "env:automation:late",
          name: "Nightly review",
          lateness: {
            ...routine().lateness,
            state: "overdue",
            overdue: true,
            latenessMs: 1_500_000,
            missedSlots: 2,
          },
        }),
        // Not run yet: an enabled check with no history.
        routine({
          key: "env:automation:audit",
          name: "Audit auditor (6 h)",
          history: [],
          lastRun: null,
          owner,
          scheduleOrTrigger: "Every 6 h",
        }),
        routine({
          key: "env:automation:healthy",
          name: "Deploy watcher",
          history: [run({ outcome: "completed" })],
        }),
        notShownFeed("env:feed:canary-probes", "Canary probes: not shown yet"),
        staleFeed("env:feed:head-availability.json", "Head availability"),
        notShownFeed("env:unadmitted-checks", "Other bots, cron and timers"),
        routine({
          key: "env:feed:reliability-health.json",
          name: "Reliability health",
          state: "failing",
          sourceStale: true,
        }),
        routine({ key: "env:automation:orphan", name: "Orphan reminder", purpose: "unclassified" }),
      ]),
    ],
    NOW,
    ZONE,
  );
}

describe("buildHarnessChecksList", () => {
  it("folds source-feed rows into one group at the end and keeps every real check above it", () => {
    const list = buildHarnessChecksList(fixture(), "");
    expect(list.feeds?.label).toBe("3 feeds not reporting");
    expect(list.feeds?.checks.map((check) => check.name).sort()).toEqual([
      "Canary probes: not shown yet",
      "Head availability",
      "Other bots, cron and timers",
    ]);
    // The check that has not run yet is a real check: it sorts into the list, above the group.
    expect(list.checks.map((check) => check.name)).toContain("Audit auditor (6 h)");
    expect(list.unclassified.map((check) => check.name)).toEqual(["Orphan reminder"]);
    expect(list.feedsOpen).toBe(false);
  });

  it("never hides or groups a failing or overdue check, feed-keyed or not, in the unfiltered list", () => {
    const list = buildHarnessChecksList(fixture(), "");
    const names = list.checks.map((check) => check.name);
    expect(names.slice(0, 3)).toEqual(["Release canary", "Reliability health", "Nightly review"]);
    expect(list.feeds?.checks.map((check) => check.name)).not.toContain("Reliability health");
    for (const check of list.checks.slice(0, 3)) expect(isHarnessFeedRow(check)).toBe(false);
  });

  it("sorts a not-run-yet check above the feed group, after the failing ones", () => {
    const list = buildHarnessChecksList(fixture(), "");
    const names = list.checks.map((check) => check.name);
    expect(names.indexOf("Audit auditor (6 h)")).toBeGreaterThan(names.indexOf("Nightly review"));
    expect(list.feeds).not.toBeNull();
  });

  it("has no group when no feed row is present", () => {
    const checks = buildHarnessChecks([snapshot([routine()])], NOW, ZONE);
    expect(buildHarnessChecksList(checks, "").feeds).toBeNull();
  });
});

describe("filtering", () => {
  const titles = harnessOwnerTitles([
    { environmentId, id: "thread-1", title: "Audit orchestrator" },
  ]);

  it("matches name, owner title, schedule text and state words, case-insensitively, all words together", () => {
    const checks = fixture();
    const names = (query: string) =>
      buildHarnessChecksList(checks, query, titles).checks.map((check) => check.name);
    expect(names("AUDITOR")).toEqual(["Audit auditor (6 h)"]);
    expect(names("orchestrator")).toEqual(["Audit auditor (6 h)"]);
    expect(names("every 6 h")).toEqual(["Audit auditor (6 h)"]);
    expect(names("failing")).toEqual(["Release canary", "Reliability health"]);
    expect(names("late")).toEqual(["Nightly review"]);
    expect(names("audit  6")).toEqual(["Audit auditor (6 h)"]);
    expect(names("audit nightly")).toEqual([]);
  });

  it("clearing the filter restores the whole list and the collapsed group", () => {
    const checks = fixture();
    const unfiltered = buildHarnessChecksList(checks, "");
    const cleared = buildHarnessChecksList(checks, "   ");
    expect(cleared).toEqual(unfiltered);
    expect(cleared.filtering).toBe(false);
  });

  it("opens the group when a match is inside it and labels the shown count", () => {
    const list = buildHarnessChecksList(fixture(), "canary");
    expect(list.checks.map((check) => check.name)).toEqual(["Release canary"]);
    expect(list.feeds?.checks.map((check) => check.name)).toEqual(["Canary probes: not shown yet"]);
    expect(list.feeds?.label).toBe("1 of 3 feeds not reporting");
    expect(list.feedsOpen).toBe(true);
  });

  it("says no checks match when nothing does, group included", () => {
    const list = buildHarnessChecksList(fixture(), "zzz");
    expect(list.noMatches).toBe(true);
    expect(list.feeds).toBeNull();
    expect(buildHarnessChecksList(fixture(), "").noMatches).toBe(false);
  });

  it("matches an unclassified routine by its state words too", () => {
    expect(
      matchesHarnessCheckQuery(
        fixture().find((check) => check.unclassified)!,
        "unclassified",
      ),
    ).toBe(true);
  });
});

describe("pinned checks in the list", () => {
  const pin = (...keys: string[]) =>
    buildHarnessChecks(
      [
        snapshot([
          routine({
            key: "env:automation:failing",
            name: "Release canary",
            state: "failing",
            history: [run({ outcome: "failed" })],
          }),
          notShownFeed("env:feed:canary-probes", "Canary probes: not shown yet"),
          routine({
            key: "env:automation:orphan",
            name: "Orphan reminder",
            purpose: "unclassified",
          }),
          routine({
            key: "env:automation:audit",
            name: "Audit auditor (6 h)",
            history: [],
            lastRun: null,
          }),
        ]),
      ].map((snap) => ({ ...snap, pinnedCheckKeys: keys })),
      NOW,
      ZONE,
    );

  it("leads the list above a failing check, and a pinned feed row or orphan is not folded away", () => {
    const list = buildHarnessChecksList(
      pin("env:automation:audit", "env:feed:canary-probes", "env:automation:orphan"),
      "",
    );
    // Pinned rows lead in their usual order: not run yet, on time, not reporting.
    expect(list.checks.map((check) => check.name).slice(0, 3)).toEqual([
      "Audit auditor (6 h)",
      "Orphan reminder",
      "Canary probes: not shown yet",
    ]);
    expect(list.checks[0]?.name).not.toBe("Release canary");
    expect(list.feeds).toBeNull();
    expect(list.unclassified).toEqual([]);
  });

  it("still filters a pinned check by the search box", () => {
    const checks = pin("env:automation:audit");
    expect(buildHarnessChecksList(checks, "audit").checks.map((check) => check.name)).toEqual([
      "Audit auditor (6 h)",
    ]);
    expect(buildHarnessChecksList(checks, "release").checks.map((check) => check.name)).toEqual([
      "Release canary",
    ]);
  });

  it("returns the feed row to its group when it is unpinned", () => {
    const list = buildHarnessChecksList(pin(), "");
    expect(list.feeds?.checks.map((check) => check.name)).toEqual(["Canary probes: not shown yet"]);
  });
});
