import { ProjectId, ThreadId, type Automation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  automationSummary,
  belongsToRoot,
  fromDraft,
  scheduleLabel,
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

  it("labels weekday schedules compactly", () => {
    const base = { kind: "weekdays", time: "09:00", timeZone: "UTC" } as const;
    expect(scheduleLabel({ ...base, days: [5, 1, 2, 3, 4] })).toBe("Weekdays at 09:00");
    expect(scheduleLabel({ ...base, days: [1, 3] })).toBe("Mon, Wed at 09:00");
  });

  it("summarizes event triggers and keeps them out of the schedule editor", () => {
    const onCi: Automation = {
      ...automation,
      triggers: [
        { type: "event", event: "ci.failed", filter: { repository: "brad/t3code-fork" } },
        ...automation.triggers,
      ],
    };
    expect(automationSummary(onCi)).toBe("When checks fail (brad/t3code-fork) or Daily at 03:00");
    expect(toDraft({ ...onCi, triggers: [onCi.triggers[0]!] })).toBeNull();
  });

  it("scopes rules to an orchestrator page", () => {
    expect(belongsToRoot(automation, root)).toBe(true);
    expect(belongsToRoot({ ...automation, ownerThreadId: ThreadId.make("other") }, root)).toBe(
      false,
    );
  });
});
