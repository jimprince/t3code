import type {
  AutomationEventKind,
  AutomationTrigger,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Something a source saw, in neutral terms. The gateway turns orchestration events into these and
 * the pollers produce the rest; `eventsFor` decides whether one is a new state worth firing on.
 */
export type AutomationObservation =
  | {
      readonly type: "pull-request-linked";
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly title: string | null;
      readonly at: string;
    }
  | {
      readonly type: "pull-request-checks";
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly title: string;
      readonly checks: "passing" | "failing" | "pending" | null;
      readonly at: string;
    }
  | {
      readonly type: "thread-waiting";
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly reason: "approval" | "input";
      readonly requestId: string;
      readonly at: string;
    }
  | {
      readonly type: "thread-session";
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly title: string;
      readonly status: string;
      readonly error: string | null;
      readonly at: string;
    }
  | {
      readonly type: "issue-labels";
      readonly projectId: ProjectId;
      readonly repository: string;
      readonly number: number;
      readonly url: string;
      readonly title: string;
      readonly labels: ReadonlyArray<string>;
      readonly at: string;
    }
  | {
      readonly type: "release";
      readonly repository: string;
      readonly tag: string;
      readonly url: string;
      readonly at: string;
    };

/** A new state that can fire automations. `projectId: null` reaches every project. */
export interface AutomationEvent {
  readonly kind: AutomationEventKind;
  readonly projectId: ProjectId | null;
  /** Stable for one state: the same failing run or label never fires twice. */
  readonly key: string;
  readonly summary: string;
  readonly url?: string;
  readonly repository?: string;
  readonly label?: string;
  readonly threadId?: ThreadId;
  readonly occurredAt: string;
}

/** The remembered value that decides transitions, or null for observations that are events. */
export function stateKey(observation: AutomationObservation): string | null {
  switch (observation.type) {
    case "pull-request-checks":
      return `checks:${observation.repository}#${observation.number}`;
    case "thread-session":
      return `session:${observation.threadId}`;
    case "issue-labels":
      return `labels:${observation.repository}#${observation.number}`;
    case "release":
      return `release:${observation.repository}`;
    default:
      return null;
  }
}

const quoted = (title: string | null) => (title ? ` "${title}"` : "");

/**
 * Turns one observation into events, given the value last remembered under its state key, and
 * returns the value to remember next. A first sighting of a polled value is a baseline: an issue
 * that was labeled, or a release published, before anyone watched does not fire.
 */
export function eventsFor(
  observation: AutomationObservation,
  previous: string | undefined,
): { readonly events: ReadonlyArray<AutomationEvent>; readonly state: string | null } {
  switch (observation.type) {
    case "pull-request-linked": {
      const ref = `${observation.repository}#${observation.number}`;
      return {
        state: null,
        events: [
          {
            kind: "pull-request.opened",
            projectId: observation.projectId,
            key: ref,
            summary: `Pull request ${ref}${quoted(observation.title)} was linked to a thread.`,
            url: observation.url,
            repository: observation.repository,
            threadId: observation.threadId,
            occurredAt: observation.at,
          },
        ],
      };
    }
    case "pull-request-checks": {
      const state = observation.checks ?? "none";
      if (state !== "failing" || previous === "failing") return { state, events: [] };
      const ref = `${observation.repository}#${observation.number}`;
      return {
        state,
        events: [
          {
            kind: "ci.failed",
            projectId: observation.projectId,
            key: `${ref}:${observation.at}`,
            summary: `Checks are failing on pull request ${ref}${quoted(observation.title)}.`,
            url: observation.url,
            repository: observation.repository,
            threadId: observation.threadId,
            occurredAt: observation.at,
          },
        ],
      };
    }
    case "thread-waiting":
      return {
        state: null,
        events: [
          {
            kind: "worker.blocked",
            projectId: observation.projectId,
            key: `${observation.threadId}:${observation.requestId}`,
            summary: `Thread "${observation.title}" is waiting for ${observation.reason === "approval" ? "an approval" : "an answer"}.`,
            threadId: observation.threadId,
            occurredAt: observation.at,
          },
        ],
      };
    case "thread-session": {
      const state = observation.status;
      if (state !== "error" || previous === "error") return { state, events: [] };
      return {
        state,
        events: [
          {
            kind: "worker.blocked",
            projectId: observation.projectId,
            key: `${observation.threadId}:error:${observation.at}`,
            summary: `Thread "${observation.title}" stopped with an error${observation.error ? `: ${observation.error}` : "."}`,
            threadId: observation.threadId,
            occurredAt: observation.at,
          },
        ],
      };
    }
    case "issue-labels": {
      const labels = [...new Set(observation.labels)].sort();
      const state = labels.join("\n");
      if (previous === undefined) return { state, events: [] };
      const before = new Set(previous.split("\n"));
      const ref = `${observation.repository}#${observation.number}`;
      return {
        state,
        events: labels
          .filter((label) => !before.has(label))
          .map((label) => ({
            kind: "issue.labeled" as const,
            projectId: observation.projectId,
            key: `${ref}:${label}:${observation.at}`,
            summary: `Issue ${ref}${quoted(observation.title)} was labeled ${label}.`,
            url: observation.url,
            repository: observation.repository,
            label,
            occurredAt: observation.at,
          })),
      };
    }
    case "release": {
      const state = observation.tag;
      if (previous === undefined || previous === state) return { state, events: [] };
      return {
        state,
        events: [
          {
            kind: "release.published",
            projectId: null,
            key: `${observation.repository}:${observation.tag}`,
            summary: `${observation.repository} published ${observation.tag}.`,
            url: observation.url,
            repository: observation.repository,
            occurredAt: observation.at,
          },
        ],
      };
    }
  }
}

/** True when an event trigger's kind and every set filter field match the event. */
export function triggerMatches(trigger: AutomationTrigger, event: AutomationEvent): boolean {
  if (trigger.type !== "event" || trigger.event !== event.kind) return false;
  const filter = trigger.filter ?? {};
  return (
    (filter.repository === undefined ||
      filter.repository.toLowerCase() === event.repository?.toLowerCase()) &&
    (filter.label === undefined || filter.label.toLowerCase() === event.label?.toLowerCase()) &&
    (filter.threadId === undefined || filter.threadId === event.threadId)
  );
}

/** Tells the agent what fired the run; appended to its prompt. */
export function eventContext(event: AutomationEvent): string {
  return [
    "---",
    `Triggered by: ${event.summary}`,
    ...(event.url ? [`Link: ${event.url}`] : []),
    ...(event.threadId ? [`Thread: ${event.threadId}`] : []),
  ].join("\n");
}
