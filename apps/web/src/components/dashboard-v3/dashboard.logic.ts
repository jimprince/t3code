import type {
  DashboardAttention,
  DashboardProject,
  DashboardRelease,
  DashboardSnapshot,
  DashboardSource,
  DashboardTask,
  EnvironmentId,
  ThreadFilePlan,
} from "@t3tools/contracts";
import { compareDashboardVersions } from "@t3tools/client-runtime/dashboard/merge";

/** The Dashboard's client-side model: snapshots of every connected environment, merged. */

export interface ScopedProject {
  /** Unique across environments: the same project id may exist on two servers. */
  readonly key: string;
  readonly environmentId: EnvironmentId;
  readonly project: DashboardProject;
}
export interface ScopedRelease {
  readonly environmentId: EnvironmentId;
  readonly release: DashboardRelease;
}
export interface DashboardData {
  /** The newest `asOf` among the merged snapshots; null before any snapshot exists. */
  readonly asOf: string | null;
  readonly projects: ReadonlyArray<ScopedProject>;
  readonly releases: ReadonlyArray<ScopedRelease>;
  readonly sources: ReadonlyArray<DashboardSource>;
  /** Briefing files the server could not bind to a project; absent from servers that predate it. */
  readonly planMigration?: ReadonlyArray<{
    readonly kind: "unbound-briefing-file";
    readonly fileName: string;
    readonly reason: string;
    readonly environmentId?: EnvironmentId;
  }>;
  /** PLAN.md progress by `filePlanKey(environmentId, threadId)`; absent from servers that predate it. */
  readonly filePlans?: Readonly<Record<string, ThreadFilePlan>>;
}

const EMPTY_DASHBOARD: DashboardData = {
  asOf: null,
  projects: [],
  releases: [],
  sources: [],
};

export function mergeSnapshots(
  parts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly snapshot: DashboardSnapshot | null;
  }>,
): DashboardData {
  const present = parts.filter(
    (part): part is { environmentId: EnvironmentId; snapshot: DashboardSnapshot } =>
      part.snapshot !== null,
  );
  if (present.length === 0) return EMPTY_DASHBOARD;
  return {
    asOf: present.map((part) => part.snapshot.asOf).reduce((a, b) => (a > b ? a : b)),
    projects: present.flatMap(({ environmentId, snapshot }) =>
      snapshot.projects.map((project) => ({
        key: `${environmentId}:${project.id}`,
        environmentId,
        project,
      })),
    ),
    releases: present.flatMap(({ environmentId, snapshot }) =>
      snapshot.releases.map((release) => ({ environmentId, release })),
    ),
    sources: present.flatMap(({ snapshot }) => snapshot.sources),
    ...(present.some(({ snapshot }) => snapshot.planMigration?.length)
      ? {
          planMigration: present.flatMap(({ environmentId, snapshot }) =>
            (snapshot.planMigration ?? []).map((warning) => ({ ...warning, environmentId })),
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Sources and freshness

export type SourceHealth = "fresh" | "stale" | "failed" | "partial";

/** A source is stale when it never succeeded or its last success is older than its cadence allows. */
export function sourceHealth(source: DashboardSource, now: number): SourceHealth {
  if (source.failed || source.coverage === "unavailable") return "failed";
  if (source.lastSuccessAt === null) return "stale";
  if (now - Date.parse(source.lastSuccessAt) > source.staleAfterMs) return "stale";
  return source.coverage === "bounded" ? "partial" : "fresh";
}

const titleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** What a source id needs to be said in words: server names and project titles, never ids. */
export interface SourceNames {
  /** Server label by environment id. */
  readonly environments: ReadonlyMap<string, string>;
  /** Project title by root thread id. */
  readonly projectTitle: (rootThreadId: string) => string | undefined;
}

/**
 * A source in words, split into the server it belongs to and what it reads: "plan:voice" is
 * "Voice tasks", "gitea:host/owner/repo" is "Gitea repo", and a read of an older server's project
 * is "<project title> tracker issues". Merged ids carry the environment id first; it names the server.
 */
function describeSource(
  source: Pick<DashboardSource, "id" | "kind">,
  names: SourceNames,
): { readonly server: string | null; readonly what: string } {
  let server: string | null = null;
  let rest = source.id;
  for (const [environmentId, label] of names.environments)
    if (rest.startsWith(`${environmentId}:`)) {
      server = label;
      rest = rest.slice(environmentId.length + 1);
      break;
    }
  const older = /^older:(.+):(issues|roadmap|asks)$/.exec(rest);
  if (older) {
    const project = names.projectTitle(older[1]!) ?? "a project";
    const part = { issues: "tracker issues", roadmap: "roadmap", asks: "pending requests" }[
      older[2] as "issues" | "roadmap" | "asks"
    ];
    return { server, what: `${project} ${part}` };
  }
  if (rest === "older:metadata") return { server, what: "Thread metadata" };
  const [, detail = ""] = rest.split(/:(.*)/s);
  switch (source.kind) {
    case "local":
      return { server, what: "Local orchestration" };
    case "gitea":
      return { server, what: `Gitea ${detail.split("/").at(-1) || detail}` };
    case "plan":
      return { server, what: `${titleCase(detail)} tasks` };
    case "release":
      return { server, what: "Release status" };
  }
}

/** One source for the sources table: "brad-linux-dev · Chief of Staff tracker issues". */
export function sourceLabel(
  source: Pick<DashboardSource, "id" | "kind">,
  names: SourceNames,
): string {
  const { server, what } = describeSource(source, names);
  return server ? `${server} · ${what}` : what;
}

/**
 * The header's one phrase about sources that are late: "brad-linux-dev: 51 reads slow, showing last
 * known". Routine lateness is not an alarm; `failed` is true only when no source has ever returned
 * data, the one case with nothing to show.
 */
export function freshnessSummary(
  sources: ReadonlyArray<DashboardSource>,
  now: number,
  names: SourceNames,
): { readonly text: string; readonly failed: boolean } | null {
  const late = sources.filter((source) => {
    const health = sourceHealth(source, now);
    return health === "stale" || health === "failed";
  });
  if (late.length === 0) return null;
  const failed = sources.every((source) => source.lastSuccessAt === null && source.failed);
  if (late.length === 1) {
    const { server, what } = describeSource(late[0]!, names);
    return { text: `${server ? `${server} ` : ""}${what} slow, showing last known`, failed };
  }
  const byServer = new Map<string, number>();
  for (const source of late) {
    const server = describeSource(source, names).server ?? "Dashboard";
    byServer.set(server, (byServer.get(server) ?? 0) + 1);
  }
  const groups = [...byServer].map(
    ([server, count]) => `${server}: ${count} ${count === 1 ? "read" : "reads"} slow`,
  );
  const shown = groups.slice(0, 2).join(", ");
  const more = groups.length > 2 ? ` and ${groups.length - 2} more` : "";
  return { text: `${shown}${more}, showing last known`, failed };
}

// ---------------------------------------------------------------------------
// Progress, movement and forecast

export interface BarSegments {
  /** Percent of the bar: done before the window, gained in it, and the forecast beyond. */
  readonly done: number;
  readonly gained: number;
  readonly projected: number;
}

/**
 * Bar math from real step counts. `gained` is capped at `done` and the projection at `total`, so
 * a replan or a stale delta can never draw past what the steps support.
 */
export function barSegments(input: {
  readonly done: number;
  readonly total: number;
  readonly gained: number;
  readonly projectedDone: number | null;
}): BarSegments {
  const { total } = input;
  if (total <= 0) return { done: 0, gained: 0, projected: 0 };
  const done = Math.min(Math.max(input.done, 0), total);
  const gained = Math.min(Math.max(input.gained, 0), done);
  const projectedDone = Math.min(Math.max(input.projectedDone ?? done, done), total);
  const pct = (steps: number) => (steps / total) * 100;
  return {
    done: pct(done - gained),
    gained: pct(gained),
    projected: pct(projectedDone - done),
  };
}

export type TaskForecast =
  | { readonly basis: "owner"; readonly eta: string }
  | { readonly basis: "pace"; readonly expectedDone: number }
  | null;

/** A tracker due date has day precision. A bare date is a date even from a server that omits it. */
export function isDateOnlyEta(forecast: { readonly eta: string; readonly precision?: string }) {
  return forecast.precision === "date" || /^\d{4}-\d{2}-\d{2}$/.test(forecast.eta);
}

/**
 * What a task is expected to do over the next window. An owner ETA is a commitment and wins. Pace
 * needs a measured delta (the server only measures with a sample about a window old), repeats it
 * once, and caps at the plan. No basis, no forecast.
 */
export function taskForecast(task: DashboardTask): TaskForecast {
  if (task.forecast) return { basis: "owner", eta: task.forecast.eta };
  const { progress, movement } = task;
  if (!progress || movement.state !== "measured" || movement.doneDelta === null) return null;
  if (movement.doneDelta <= 0 || task.status === "done") return null;
  return {
    basis: "pace",
    expectedDone: Math.min(progress.total, progress.done + movement.doneDelta),
  };
}

export interface Rollup {
  /** Steps over tasks that have a step list; null when none has one, so no bar is drawn. */
  readonly steps: { readonly done: number; readonly total: number } | null;
  /** Open tasks without a step list: "+1 unplanned". */
  readonly unplanned: number;
  /** Steps gained in the window; null when no task's movement was measured. */
  readonly gained: number | null;
  readonly replanned: boolean;
  /** Steps expected done at the end of the next window, from pace and owner ETAs. */
  readonly projectedDone: number | null;
  /** The latest owner ETA among the tasks. */
  readonly ownerEta: string | null;
  /** The ETA is a calendar day (a tracker due date), so it is shown as a date, never a time. */
  readonly ownerEtaDateOnly: boolean;
  readonly paceBasis: boolean;
  readonly closed: number;
  /** No steps in the window although the plan is open: the only stall the snapshot can prove. */
  readonly idle: number;
}

/**
 * Whether a task has a real step list. A tracker task without a checklist carries a counting-only
 * 0/1 (or 1/1 once closed); that is not a measured plan and never draws a bar or enters a total.
 */
export function hasStepList(task: DashboardTask): task is DashboardTask & {
  readonly progress: NonNullable<DashboardTask["progress"]>;
} {
  return task.progress !== null && task.hasChecklist !== false;
}

/** Sums tasks into a workstream, project or release figure without inventing any missing part. */
export function rollup(tasks: ReadonlyArray<DashboardTask>): Rollup {
  let done = 0;
  let total = 0;
  let planned = 0;
  let unplanned = 0;
  let gained = 0;
  let measured = 0;
  let projected = 0;
  let projectedAny = false;
  let replanned = false;
  let ownerEta: string | null = null;
  let ownerEtaDateOnly = false;
  let paceBasis = false;
  let closed = 0;
  let idle = 0;
  const noteOwnerEta = (task: DashboardTask) => {
    const forecast = task.forecast;
    if (!forecast || (ownerEta && forecast.eta <= ownerEta)) return;
    ownerEta = forecast.eta;
    ownerEtaDateOnly = isDateOnlyEta(forecast);
  };
  for (const task of tasks) {
    if (task.status === "done") closed += 1;
    if (!hasStepList(task)) {
      if (task.status !== "done") {
        unplanned += 1;
        // A tracker task's due date is a commitment even with no checklist to measure. A row that
        // never had progress keeps its old behaviour and adds no ETA.
        if (task.progress !== null) noteOwnerEta(task);
      }
      continue;
    }
    planned += 1;
    done += task.progress.done;
    total += task.progress.total;
    const { movement } = task;
    if (movement.state === "measured" && movement.doneDelta !== null) {
      measured += 1;
      gained += Math.max(0, movement.doneDelta);
      if (
        movement.doneDelta === 0 &&
        task.status === "working" &&
        task.progress.done < task.progress.total
      )
        idle += 1;
    } else if (movement.state === "replanned") replanned = true;
    const forecast = taskForecast(task);
    projected += task.progress.done;
    if (forecast?.basis === "pace") {
      projected += forecast.expectedDone - task.progress.done;
      projectedAny = true;
      paceBasis = true;
    } else if (forecast?.basis === "owner") {
      projectedAny = true;
      noteOwnerEta(task);
    }
  }
  return {
    steps: planned > 0 ? { done, total } : null,
    unplanned,
    gained: measured > 0 ? gained : null,
    replanned,
    projectedDone: projectedAny && projected > done ? projected : null,
    ownerEta,
    ownerEtaDateOnly,
    paceBasis,
    closed,
    idle,
  };
}

// ---------------------------------------------------------------------------
// Decisions

/** The order of the one Decisions feed: blocking tier, then deadline, then newest. */
export function rankDecisions<T extends DashboardAttention>(items: ReadonlyArray<T>): T[] {
  return items.toSorted(
    (a, b) =>
      a.priority - b.priority ||
      (a.deadline ?? "9999").localeCompare(b.deadline ?? "9999") ||
      b.updatedAt.localeCompare(a.updatedAt),
  );
}

/** A task id from the snapshot, `issue:host/owner/repo#N`, as the task panel and answers need it. */
export function parseIssueTaskId(
  id: string,
): { readonly host: string; readonly repository: string; readonly number: number } | null {
  const match = /^issue:([^/]+)\/(.+)#(\d+)$/.exec(id);
  if (!match) return null;
  return { host: match[1]!, repository: match[2]!, number: Number(match[3]) };
}

/** How long a delivered answer stays on screen at least, so it never just vanishes. */
export const ANSWER_LINGER_MS = 6_000;
/** The longest a delivered answer is held back while the snapshot still lists the decision. */
export const ANSWER_CAP_MS = 10 * 60_000;

/**
 * Whether a delivered answer can stop being remembered. The snapshot lags the answer by a Gitea
 * refresh, so a decision that is still listed stays answered (never back to open) until it leaves
 * the snapshot or the cap passes.
 */
export function answerSettled(input: {
  readonly sentAt: number;
  readonly stillOpen: boolean;
  readonly now: number;
}): boolean {
  const age = input.now - input.sentAt;
  return age >= ANSWER_CAP_MS || (!input.stillOpen && age >= ANSWER_LINGER_MS);
}

// ---------------------------------------------------------------------------
// Releases

export type VersionState = "unknown" | "behind" | "current";

/**
 * Installed against latest. Only an installed version older than a known latest is "behind"; with
 * no known latest nothing can be said, and an installed build newer than latest is current.
 */
export function versionState(installed: string | null, latest: string | null): VersionState {
  if (installed === null || latest === null) return "unknown";
  return compareDashboardVersions(installed, latest) < 0 ? "behind" : "current";
}

// ---------------------------------------------------------------------------
// Since you looked: a client-side baseline

export interface BaselineTask {
  readonly title: string;
  readonly status: DashboardTask["status"];
  readonly done: number | null;
  readonly total: number | null;
}
/** What this device saw when it last looked; compact enough for localStorage. */
export interface Baseline {
  readonly at: string;
  readonly tasks: Readonly<Record<string, BaselineTask>>;
  readonly attention: ReadonlyArray<string>;
}

export function takeBaseline(data: DashboardData, at: string): Baseline {
  const tasks: Record<string, BaselineTask> = {};
  const attention: string[] = [];
  for (const { key, project } of data.projects) {
    for (const task of project.tasks)
      tasks[`${key}|${task.id}`] = {
        title: task.title,
        status: task.status,
        done: hasStepList(task) ? task.progress.done : null,
        total: hasStepList(task) ? task.progress.total : null,
      };
    for (const item of project.attention) attention.push(`${key}|${item.id}`);
  }
  return { at, tasks, attention };
}

export type ChangeKind = "done" | "steps" | "replanned" | "decision-new";
export interface Change {
  readonly kind: ChangeKind;
  readonly projectKey: string;
  readonly taskId: string | null;
  readonly text: string;
}

/**
 * Finished work, step advances, replans and new decisions since the baseline. A task the baseline
 * never saw is not reported as a change: it may only have been outside the snapshot before.
 */
export function diffAgainst(
  data: DashboardData,
  baseline: Baseline,
): { readonly changes: ReadonlyArray<Change>; readonly outcomes: ReadonlyArray<Change> } {
  const changes: Change[] = [];
  const outcomes: Change[] = [];
  const known = new Set(baseline.attention);
  for (const { key, project } of data.projects) {
    for (const task of project.tasks) {
      const before = baseline.tasks[`${key}|${task.id}`];
      if (!before) continue;
      if (task.status === "done" && before.status !== "done") {
        const change: Change = {
          kind: "done",
          projectKey: key,
          taskId: task.id,
          text: task.title,
        };
        changes.push(change);
        outcomes.push(change);
        continue;
      }
      const now = hasStepList(task) ? task.progress : null;
      if (!now || before.done === null || before.total === null) continue;
      if (now.total !== before.total) {
        changes.push({
          kind: "replanned",
          projectKey: key,
          taskId: task.id,
          text: `${task.title} replanned ${before.total}→${now.total} steps`,
        });
      } else if (now.done > before.done) {
        changes.push({
          kind: "steps",
          projectKey: key,
          taskId: task.id,
          text: `${task.title} ${before.done}→${now.done} of ${now.total}`,
        });
      }
    }
    for (const item of project.attention)
      if (!known.has(`${key}|${item.id}`))
        changes.push({
          kind: "decision-new",
          projectKey: key,
          taskId: item.taskId,
          text: item.title,
        });
  }
  return { changes, outcomes };
}

/**
 * What the log shows on a first visit, when there is no baseline to diff against: the last 24 hours
 * of finished work and every decision that is open now.
 */
export function firstVisitChanges(data: DashboardData, since: string): ReadonlyArray<Change> {
  const decisions = data.projects.flatMap(({ key, project }) =>
    project.attention.map((item): Change => ({
      kind: "decision-new",
      projectKey: key,
      taskId: item.taskId,
      text: item.title,
    })),
  );
  const done = outcomesSince(data, since).map((outcome): Change => ({
    kind: "done",
    projectKey: outcome.projectKey,
    taskId: outcome.task.id,
    text: outcome.task.title,
  }));
  return [...decisions, ...done];
}

export interface Outcome {
  readonly projectKey: string;
  readonly task: DashboardTask;
  readonly at: string;
}

/**
 * Tasks the snapshot says were closed after `since`, newest first. Closed is not deployed: the
 * level shown for each is only what the snapshot knows. A done task without a close time is left
 * out rather than guessed.
 */
export function outcomesSince(data: DashboardData, since: string): Outcome[] {
  return data.projects
    .flatMap(({ key, project }) =>
      project.tasks.flatMap((task) =>
        task.status === "done" && task.closedAt !== null && task.closedAt >= since
          ? [{ projectKey: key, task, at: task.closedAt }]
          : [],
      ),
    )
    .toSorted((a, b) => b.at.localeCompare(a.at));
}

// ---------------------------------------------------------------------------
// Project tree

/** A project's nested subprojects, shallow first, from the flat snapshot list. */
export function subprojectsOf(
  projects: ReadonlyArray<ScopedProject>,
  of: ScopedProject,
): ScopedProject[] {
  const out: ScopedProject[] = [];
  const queue = [of];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const candidate of projects) {
      if (
        candidate.environmentId === parent.environmentId &&
        candidate.project.parentId === parent.project.id &&
        !out.includes(candidate)
      ) {
        out.push(candidate);
        queue.push(candidate);
      }
    }
  }
  return out;
}

/** Top-level products first, then utilities; nested projects appear under their parent. */
export function topLevelProjects(projects: ReadonlyArray<ScopedProject>): {
  readonly products: ScopedProject[];
  readonly utilities: ScopedProject[];
} {
  const present = new Set(projects.map((p) => `${p.environmentId}:${p.project.id}`));
  const top = projects.filter(
    (p) => p.project.parentId === null || !present.has(`${p.environmentId}:${p.project.parentId}`),
  );
  return {
    products: top.filter((p) => !p.project.utility),
    utilities: top.filter((p) => p.project.utility),
  };
}

/** The tasks of a workstream, in the order the snapshot lists them. */
function workstreamTasks(
  project: DashboardProject,
  workstream: DashboardProject["workstreams"][number],
): DashboardTask[] {
  const wanted = new Set(workstream.taskIds);
  return project.tasks.filter((task) => wanted.has(task.id));
}

export type PlanWorkstream = DashboardProject["workstreams"][number];

/** One workstream of the Plan: its listed tasks, and any child workstreams nested under it. */
export interface PlanWorkstreamEntry {
  readonly workstream: PlanWorkstream;
  readonly tasks: DashboardTask[];
  /**
   * The epic's own task, when the snapshot keeps it (only to carry a waiting decision). It is a
   * header's link target and never listed as a row.
   */
  readonly ownTask: DashboardTask | null;
  readonly children: PlanWorkstreamEntry[];
}

/** A tracker epic header has its own issue; the Unsorted group and briefing bands do not. */
export function isEpicHeader(workstream: PlanWorkstream): boolean {
  return typeof workstream.url === "string";
}

/**
 * A project's workstreams with the tasks to list under each. An epic heads its own workstream (its
 * id is that workstream's id), so it is not repeated as a task row inside the workstream it sits
 * in. A workstream left with no task is dropped, except a tracker epic header: an epic with no
 * children, or whose finished children are not listed, is still a heading.
 */
export function planWorkstreams(project: DashboardProject): PlanWorkstreamEntry[] {
  const entries = project.workstreams
    .map((workstream) => ({
      workstream,
      tasks: workstreamTasks(project, workstream),
      ownTask: project.tasks.find((task) => task.id === workstream.id) ?? null,
      children: [] as PlanWorkstreamEntry[],
    }))
    .filter((entry) => entry.tasks.length > 0 || isEpicHeader(entry.workstream));
  const epicIds = new Set(entries.map((entry) => entry.workstream.id));
  return entries
    .map((entry) => ({
      ...entry,
      tasks: entry.tasks.filter((task) => !epicIds.has(task.id) || task.id === entry.workstream.id),
    }))
    .filter((entry) => entry.tasks.length > 0 || isEpicHeader(entry.workstream));
}

/**
 * Nests each workstream under its parent epic when that parent is listed too. The parent counts the
 * child once in its own children; nesting is only where the rows sit, so no figure is summed.
 * Order stays the snapshot's.
 */
export function nestWorkstreams(
  entries: ReadonlyArray<PlanWorkstreamEntry>,
): PlanWorkstreamEntry[] {
  const byId = new Map(entries.map((entry) => [entry.workstream.id, entry]));
  const parentOf = (entry: PlanWorkstreamEntry) => {
    const parent = entry.workstream.parentWorkstreamId;
    return parent && parent !== entry.workstream.id ? (byId.get(parent) ?? null) : null;
  };
  // A parent chain that loops would leave every member without a root; list those at the top level.
  const reachesRoot = (entry: PlanWorkstreamEntry): boolean => {
    const seen = new Set<string>();
    for (let at: PlanWorkstreamEntry | null = entry; at; at = parentOf(at)) {
      if (seen.has(at.workstream.id)) return false;
      seen.add(at.workstream.id);
    }
    return true;
  };
  const nested = entries.map((entry) => ({ ...entry, children: [] as PlanWorkstreamEntry[] }));
  const nestedById = new Map(nested.map((entry) => [entry.workstream.id, entry]));
  const roots: PlanWorkstreamEntry[] = [];
  for (const entry of nested) {
    const parent = parentOf(entry);
    if (parent && reachesRoot(entry)) nestedById.get(parent.workstream.id)!.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

/** Every task listed under a workstream, nested ones included, plus the epic's own kept task. */
export function entryTasks(entry: PlanWorkstreamEntry): DashboardTask[] {
  return [
    ...(entry.ownTask ? [entry.ownTask] : []),
    ...entry.tasks,
    ...entry.children.flatMap(entryTasks),
  ];
}

const MEMBERSHIP_WORDS: Readonly<Record<string, string>> = {
  "conflicting-checklist-parents": "listed under several parent checklists",
  "cyclic-membership": "its parents form a loop",
  "malformed-parent": "its Part of line is malformed",
  "self-reference": "it names itself as its parent",
  "missing-or-closed-parent": "its parent is missing or closed",
};

/**
 * The tracker's warnings on one issue, each as a short line. A truncated body is a read limit, not
 * a membership problem, so it is never prefixed "Membership:".
 */
export function planNotes(warnings: ReadonlyArray<string> | undefined): string[] {
  if (!warnings) return [];
  const unique = [...new Set(warnings)];
  const membership = unique
    .filter((code) => code !== "truncated-body")
    .map((code) => MEMBERSHIP_WORDS[code] ?? code.replaceAll("-", " "));
  return [
    ...(unique.includes("truncated-body") ? ["Plan body truncated"] : []),
    ...(membership.length > 0 ? [`Membership: ${membership.join("; ")}`] : []),
  ];
}

/** "Unbound briefing file: t3-product.json": a source:tracker file that matches no project. */
export function unboundBriefingLabel(warning: { readonly fileName: string }): string {
  return `Unbound briefing file: ${warning.fileName}`;
}

/**
 * How many projects on Home open their workstreams by default. The rest show their workstream rows
 * collapsed, so the first paint draws a screenful rather than every task of every project.
 */
export const EAGER_PROJECTS = 2;

/**
 * Home's order of products: what needs a decision first, then work that is moving, then queued
 * work, then finished work. Projects with no tasks at all are returned apart as `idle`, for one
 * trailing line. The order inside a rank is the snapshot's.
 */
export function orderProducts(
  products: ReadonlyArray<ScopedProject>,
  all: ReadonlyArray<ScopedProject>,
): { readonly ordered: ScopedProject[]; readonly idle: ScopedProject[] } {
  const rank = (scoped: ScopedProject): number | null => {
    const tasks = projectTasks(all, scoped);
    // A decision counts wherever it sits, including on a tracker epic's own task, which
    // `projectTasks` leaves out of the counts but the server keeps only because it carries one.
    if (waitsOnBrad(all, scoped)) return 0;
    if (tasks.length === 0) return scoped.project.omittedTaskCount > 0 ? 2 : null;
    const open = tasks.filter((task) => task.status !== "done");
    if (
      open.some(
        (task) =>
          task.status === "working" ||
          task.status === "review" ||
          (task.movement.state === "measured" && (task.movement.doneDelta ?? 0) > 0),
      )
    )
      return 1;
    return open.length > 0 ? 2 : 3;
  };
  const ranked = products.map((scoped, index) => ({ scoped, index, rank: rank(scoped) }));
  return {
    ordered: ranked
      .filter((entry) => entry.rank !== null)
      .toSorted((a, b) => a.rank! - b.rank! || a.index - b.index)
      .map((entry) => entry.scoped),
    idle: ranked.filter((entry) => entry.rank === null).map((entry) => entry.scoped),
  };
}

/** Whether anything in a project or its subprojects is waiting on Brad, from the unfiltered tasks. */
export function waitsOnBrad(projects: ReadonlyArray<ScopedProject>, of: ScopedProject): boolean {
  return [of, ...subprojectsOf(projects, of)].some(
    (p) => p.project.attention.length > 0 || p.project.tasks.some((t) => t.attentionIds.length > 0),
  );
}

/** A project's tasks and those of its subprojects, for its own line on Home. */
export function projectTasks(
  projects: ReadonlyArray<ScopedProject>,
  of: ScopedProject,
): DashboardTask[] {
  return [of, ...subprojectsOf(projects, of)].flatMap((p) => {
    // A tracker epic's own task is kept only to carry a waiting decision. The epic is a workstream
    // header, already counted once as a child of its parent, so it is not another open task here.
    if (p.project.planSource !== "tracker") return p.project.tasks;
    const epics = new Set(p.project.workstreams.map((workstream) => workstream.id));
    return p.project.tasks.filter((task) => !epics.has(task.id));
  });
}

// ---------------------------------------------------------------------------
// Time

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** "7:42 am" today, "Fri 2:00 pm" within a week, "Oct 3" beyond; local time. */
export function formatClock(iso: string, now: number): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = timeFormat
    .format(at)
    .replace(/\s?(AM|PM)$/i, (_, m: string) => ` ${m.toLowerCase()}`);
  const days = Math.floor((at.getTime() - startOfDay(now)) / 86_400_000);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${dayFormat.format(at)} ${time}`;
  return dateFormat.format(at);
}

const utcDayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/**
 * A due date as "Oct 20": the calendar day as written. It is built and formatted in UTC, so no
 * time zone can move it to a neighbouring day. The year follows only when it is not this one.
 */
export function formatEtaDay(eta: string, now: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(eta);
  if (!match) return eta;
  const year = Number(match[1]);
  const text = utcDayFormat.format(
    new Date(Date.UTC(year, Number(match[2]) - 1, Number(match[3]))),
  );
  return year === new Date(now).getFullYear() ? text : `${text}, ${year}`;
}

/** An owner ETA: a date for a tracker due date, a clock time for a source that sent an instant. */
export function formatEta(eta: string, dateOnly: boolean, now: number): string {
  return dateOnly ? formatEtaDay(eta, now) : formatClock(eta, now);
}

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** A decision deadline when it parses as a time; free text such as "Oct 14" is shown as written. */
export function formatDeadline(deadline: string, now: number): string {
  return Number.isNaN(Date.parse(deadline)) || !/\d{4}-\d{2}-\d{2}/.test(deadline)
    ? deadline
    : formatClock(deadline, now);
}

/** "6m", "2h 32m", "3d": how old a fact is. */
export function ageLabel(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (Number.isNaN(minutes)) return "";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 2 * 24 * 60) {
    const rest = minutes % 60;
    return `${Math.floor(minutes / 60)}h${rest ? ` ${rest}m` : ""}`;
  }
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/**
 * When progress was last confirmed, or null when the snapshot does not know. The tracker sends an
 * epoch placeholder with `confirmationKnown: false` for a first observation; it is not a date.
 */
export function knownConfirmation(
  progress: { readonly confirmedAt: string; readonly confirmationKnown?: boolean } | null,
): string | null {
  return progress && progress.confirmationKnown !== false ? progress.confirmedAt : null;
}

/** The newest known `confirmedAt` among tasks with a step list: how current a workstream's figures are. */
export function newestConfirmation(tasks: ReadonlyArray<DashboardTask>): string | null {
  const times = tasks.flatMap((task) => {
    const at = hasStepList(task) ? knownConfirmation(task.progress) : null;
    return at ? [at] : [];
  });
  return times.length > 0 ? times.reduce((a, b) => (a > b ? a : b)) : null;
}

/** Projects visible on a project's own page: it and everything nested under it. */
export function scopeToProject(
  data: DashboardData,
  environmentId: EnvironmentId,
  rootThreadId: string,
): { readonly data: DashboardData; readonly root: ScopedProject | null } {
  const root =
    data.projects.find(
      (candidate) =>
        candidate.environmentId === environmentId &&
        candidate.project.rootThreadId === rootThreadId,
    ) ?? null;
  if (!root) return { data: { ...data, projects: [], releases: [] }, root: null };
  const projects = [root, ...subprojectsOf(data.projects, root)];
  const taskIds = new Set(projects.flatMap((p) => p.project.tasks.map((task) => task.id)));
  return {
    root,
    data: {
      ...data,
      projects,
      releases: data.releases.filter(
        (entry) =>
          entry.environmentId === environmentId &&
          entry.release.taskId !== null &&
          taskIds.has(entry.release.taskId),
      ),
    },
  };
}
