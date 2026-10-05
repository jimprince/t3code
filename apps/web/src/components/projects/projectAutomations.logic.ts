import type {
  Automation,
  AutomationAgentTarget,
  AutomationDefinition,
  AutomationEventKind,
  AutomationTrigger,
  AutomationSchedule,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The one-schedule, one-prompt shape the project panel edits. */
export interface AutomationDraft {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly ownerThreadId?: ThreadId;
  readonly schedule: AutomationSchedule;
  readonly prompt: string;
  readonly target: AutomationAgentTarget;
}

/** Null when the rule has more than the panel can edit (several triggers or actions, a script). */
export function toDraft(automation: Automation): AutomationDraft | null {
  const [trigger] = automation.triggers;
  const [action] = automation.actions;
  if (
    automation.triggers.length !== 1 ||
    automation.actions.length !== 1 ||
    trigger === undefined ||
    trigger.type !== "schedule" ||
    action === undefined ||
    action.prompt === undefined
  )
    return null;
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    ...(automation.ownerThreadId ? { ownerThreadId: automation.ownerThreadId } : {}),
    schedule: trigger.schedule,
    prompt: action.prompt,
    target: action.target,
  };
}

export function fromDraft(draft: AutomationDraft, projectId: ProjectId): AutomationDefinition {
  return {
    id: draft.id,
    projectId,
    name: draft.name,
    enabled: draft.enabled,
    ...(draft.ownerThreadId ? { ownerThreadId: draft.ownerThreadId } : {}),
    triggers: [{ type: "schedule", schedule: draft.schedule }],
    actions: [{ type: "agent", prompt: draft.prompt, target: draft.target }],
  };
}

export function scheduleLabel(schedule: AutomationSchedule): string {
  switch (schedule.kind) {
    case "hourly":
      return "Every hour";
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekly":
      return `${DAY_NAMES[schedule.day]} at ${schedule.time}`;
    case "weekdays": {
      const days = [...schedule.days].sort((a, b) => a - b);
      const weekdays = days.join(",") === "1,2,3,4,5";
      return `${weekdays ? "Weekdays" : days.map((day) => DAY_NAMES[day]?.slice(0, 3)).join(", ")} at ${schedule.time}`;
    }
    case "cron":
      return `Cron ${schedule.expression}`;
  }
}

const EVENT_LABELS: Record<AutomationEventKind, string> = {
  "pull-request.opened": "When a pull request is linked",
  "ci.failed": "When checks fail",
  "issue.labeled": "When an issue is labeled",
  "worker.blocked": "When a worker is blocked",
  "release.published": "On a new release",
};

function triggerLabel(trigger: AutomationTrigger): string {
  if (trigger.type === "schedule") return scheduleLabel(trigger.schedule);
  const filter = trigger.filter ?? {};
  const scope = [filter.label, filter.repository].filter(Boolean).join(" in ");
  return `${EVENT_LABELS[trigger.event]}${scope ? ` (${scope})` : ""}`;
}

export function automationSummary(automation: Automation): string {
  const labels = automation.triggers.map(triggerLabel);
  return labels.length === 0 ? "Manual only" : labels.join(" or ");
}

/**
 * On an orchestrator's page, show rules it owns or targets, plus unowned rules that only start
 * new threads (they belong to the project as a whole).
 */
export function belongsToRoot(automation: Automation, rootThreadId: ThreadId | undefined) {
  if (rootThreadId === undefined || automation.ownerThreadId === rootThreadId) return true;
  return automation.actions.some((action) =>
    action.target.kind === "existing-thread"
      ? action.target.threadId === rootThreadId
      : automation.ownerThreadId === undefined,
  );
}
