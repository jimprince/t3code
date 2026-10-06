import type {
  Automation,
  AutomationAgentTarget,
  AutomationDefinition,
  AutomationResultMode,
  AutomationRun,
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
  readonly resultMode?: AutomationResultMode;
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
    ...(action.resultMode ? { resultMode: action.resultMode } : {}),
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
    actions: [
      {
        type: "agent",
        prompt: draft.prompt,
        target: draft.target,
        ...(draft.resultMode ? { resultMode: draft.resultMode } : {}),
      },
    ],
  };
}

const SHORT_DAYS = DAY_NAMES.map((day) => day.slice(0, 3));

/** A compact duration: "<1m", "45m", "5h", "3d". */
export function shortDuration(ms: number): string {
  const minutes = Math.round(Math.abs(ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function parts(at: number, timeZone: string) {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    weekday: values.weekday ?? "",
    time: `${values.hour}:${values.minute}`,
    zone: values.timeZoneName ?? "",
  };
}

/** "Daily 01:00 MDT"; the zone abbreviation is the one in force at `at`. */
function scheduleText(schedule: AutomationSchedule, at: number): string {
  if (schedule.kind === "hourly") return "Hourly";
  const zone = parts(at, schedule.timeZone).zone;
  if (schedule.kind === "cron") return `Cron ${schedule.expression} ${zone}`;
  const when =
    schedule.kind === "daily"
      ? "Daily"
      : schedule.kind === "weekly"
        ? SHORT_DAYS[schedule.day]
        : [...schedule.days].sort((a, b) => a - b).join(",") === "1,2,3,4,5"
          ? "Weekdays"
          : [...schedule.days]
              .sort((a, b) => a - b)
              .map((day) => SHORT_DAYS[day])
              .join(", ");
  return `${when} ${schedule.time} ${zone}`;
}

/** "On ci.failed · jimprince/t3code" for event rules, the schedule otherwise. */
function triggerText(trigger: AutomationTrigger, at: number): string {
  if (trigger.type === "schedule") return scheduleText(trigger.schedule, at);
  const filter = trigger.filter ?? {};
  return [`On ${trigger.event}`, filter.repository, filter.label].filter(Boolean).join(" · ");
}

const RUN_WORDS: Record<AutomationRun["status"], string> = {
  completed: "ok",
  failed: "failed",
  skipped: "skipped",
  running: "running",
  queued: "queued",
};

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * The muted second line of a rule: triggers, the next run as relative time plus a short date,
 * where it runs (left out when that repeats the name), and the newest run's result and age.
 */
export function ruleLine(input: {
  readonly automation: Automation;
  readonly now: number;
  /** Where its agent turns go, as the user knows it ("new thread", a thread title). */
  readonly target: string | null;
  readonly lastRun: AutomationRun | undefined;
}): { readonly summary: string; readonly last: string | null } {
  const { automation, now, target, lastRun } = input;
  const next = automation.nextRunAt === null ? null : Date.parse(automation.nextRunAt);
  const timeZone = automation.triggers.flatMap((trigger) =>
    trigger.type === "schedule" ? [trigger.schedule.timeZone] : [],
  )[0];
  const triggers = automation.triggers.map((trigger) => triggerText(trigger, next ?? now));
  const nextText = !automation.enabled
    ? "paused"
    : next === null
      ? null
      : next <= now
        ? "due now"
        : `next in ${shortDuration(next - now)}${
            timeZone ? ` (${parts(next, timeZone).weekday} ${parts(next, timeZone).time})` : ""
          }`;
  const repeatsName =
    target !== null &&
    (normalize(automation.name).includes(normalize(target)) ||
      normalize(target).includes(normalize(automation.name)));
  const summary = [
    triggers.length === 0 ? "Manual only" : triggers.join(" or "),
    nextText,
    target !== null && !repeatsName ? `runs in: ${target}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  if (lastRun === undefined) return { summary, last: null };
  const at = Date.parse(lastRun.finishedAt ?? lastRun.steps[0]?.startedAt ?? lastRun.createdAt);
  const age = now - at < 60_000 ? "just now" : `${shortDuration(now - at)} ago`;
  return {
    summary,
    last: `last: ${lastRun.dryRun ? "dry run" : RUN_WORDS[lastRun.status]} ${age}`,
  };
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
