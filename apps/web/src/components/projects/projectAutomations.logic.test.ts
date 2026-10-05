import { ProjectId, ThreadId, type Automation, type AutomationRun } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  belongsToRoot,
  fromDraft,
  ruleLine,
  shortDuration,
  toDraft,
} from "./projectAutomations.logic";

const root = ThreadId.make("root");
const automation: Automation = {
  id: "a",
  projectId: ProjectId.make("p"),
  name: "Digest",
  enabled: true,
  triggers: [{ type: "schedule", schedule: { kind: "daily", time: "03:00", timeZone: "UTC" } }],
  actions: [{ type: "agent", prompt: "Go", target: { kind: "new-thread" } }],
  nextRunAt: null,
  createdAt: "2026-10-05T00:00:00.000Z",
  updatedAt: "2026-10-05T00:00:00.000Z",
};

describe("project automation panel logic", () => {
  it("round-trips a simple rule and refuses rules the panel cannot edit", () => {
    const draft = toDraft(automation)!;
    expect(fromDraft(draft, automation.projectId)).toEqual({
      id: "a",
      projectId: "p",
      name: "Digest",
      enabled: true,
      triggers: automation.triggers,
      actions: automation.actions,
    });
    expect(
      toDraft({
        ...automation,
        actions: [{ type: "agent", script: "review", target: { kind: "new-thread" } }],
      }),
    ).toBeNull();
  });

  // 2026-10-06T01:00Z is Mon 19:00 MDT in Denver.
  const now = Date.parse("2026-10-06T01:00:00.000Z");
  const nightly: Automation = {
    ...automation,
    name: "Daily orchestrators' meeting (overnight)",
    triggers: [
      { type: "schedule", schedule: { kind: "daily", time: "01:00", timeZone: "America/Denver" } },
    ],
    nextRunAt: "2026-10-06T07:00:00.000Z",
  };
  const run = (status: AutomationRun["status"], finishedAt: string): AutomationRun => ({
    id: "r",
    automationId: "a",
    projectId: automation.projectId,
    name: "Digest",
    dedupeKey: "k",
    trigger: { kind: "manual" },
    dryRun: false,
    status,
    result: null,
    steps: [],
    createdAt: finishedAt,
    finishedAt,
  });

  it("reads a scheduled rule as schedule, relative next run with a short date, and target", () => {
    expect(ruleLine({ automation: nightly, now, target: "Ops room", lastRun: undefined })).toEqual({
      summary: "Daily 01:00 MDT · next in 6h (Tue 01:00) · runs in: Ops room",
      last: null,
    });
  });

  it("leaves out a target that repeats the name and reports the last run", () => {
    expect(
      ruleLine({
        automation: nightly,
        now,
        target: "Daily orchestrators' meeting",
        lastRun: run("completed", "2026-10-05T23:00:00.000Z"),
      }),
    ).toEqual({
      summary: "Daily 01:00 MDT · next in 6h (Tue 01:00)",
      last: "last: ok 2h ago",
    });
  });

  it("reads event, paused and weekday rules", () => {
    const onCi: Automation = {
      ...automation,
      nextRunAt: null,
      triggers: [{ type: "event", event: "ci.failed", filter: { repository: "jimprince/t3code" } }],
    };
    expect(
      ruleLine({ automation: onCi, now, target: "new thread", lastRun: undefined }).summary,
    ).toBe("On ci.failed · jimprince/t3code · runs in: new thread");
    expect(toDraft(onCi)).toBeNull();
    const weekdays: Automation = {
      ...nightly,
      enabled: false,
      triggers: [
        {
          type: "schedule",
          schedule: { kind: "weekdays", time: "09:00", days: [5, 1, 2, 3, 4], timeZone: "UTC" },
        },
      ],
    };
    expect(
      ruleLine({
        automation: weekdays,
        now,
        target: null,
        lastRun: run("failed", "2026-10-06T00:59:40.000Z"),
      }),
    ).toEqual({ summary: "Weekdays 09:00 UTC · paused", last: "last: failed just now" });
  });

  it("rounds durations to one unit", () => {
    expect([20_000, 45 * 60_000, 4.6 * 3_600_000, 50 * 3_600_000].map(shortDuration)).toEqual([
      "<1m",
      "45m",
      "5h",
      "2d",
    ]);
  });

  it("scopes rules to an orchestrator page", () => {
    expect(belongsToRoot(automation, root)).toBe(true);
    expect(belongsToRoot({ ...automation, ownerThreadId: ThreadId.make("other") }, root)).toBe(
      false,
    );
  });
});
