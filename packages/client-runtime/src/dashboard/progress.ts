import type {
  DashboardMovement,
  DashboardProgress,
  DashboardSnapshot,
  DashboardTask,
} from "@t3tools/contracts";

export interface ProgressSample {
  readonly taskId: string;
  readonly at: string;
  readonly done: number;
  readonly total: number;
  readonly planVersion: string;
}
type IndexedSample = ProgressSample & { readonly atMs: number };
export function indexSamples(
  samples: readonly ProgressSample[],
): ReadonlyMap<string, readonly IndexedSample[]> {
  const index = new Map<string, IndexedSample[]>();
  for (const sample of samples) {
    const row = { ...sample, atMs: Date.parse(sample.at) };
    const list = index.get(sample.taskId) ?? [];
    list.push(row);
    index.set(sample.taskId, list);
  }
  for (const list of index.values()) list.sort((a, b) => a.atMs - b.atMs);
  return index;
}
const MOVEMENT_WINDOW_MS = 60 * 60_000;
/** Require a real sample within ten minutes of the window boundary, with an unchanged plan throughout. */
export function movement(
  taskId: string,
  progress: DashboardProgress | null,
  samples: readonly ProgressSample[] | ReadonlyMap<string, readonly IndexedSample[]>,
  now: string,
): DashboardMovement {
  const unknown: DashboardMovement = {
    state: "unknown",
    doneDelta: null,
    windowMs: MOVEMENT_WINDOW_MS,
    fromAt: null,
    toAt: now,
  };
  if (
    !progress ||
    progress.confirmationKnown === false ||
    Date.parse(now) - Date.parse(progress.confirmedAt) > 2 * MOVEMENT_WINDOW_MS
  )
    return unknown;
  const boundary = Date.parse(now) - MOVEMENT_WINDOW_MS;
  const index = Array.isArray(samples)
    ? indexSamples(samples)
    : (samples as ReadonlyMap<string, readonly IndexedSample[]>);
  const history = (index.get(taskId) ?? []).filter((s) => s.atMs <= Date.parse(now));
  let first: IndexedSample | undefined;
  for (const sample of history) if (sample.atMs <= boundary) first = sample;
  if (!first || boundary - first.atMs > 10 * 60_000) return unknown;
  if (
    first.total !== progress.total ||
    first.planVersion !== progress.planVersion ||
    history.some(
      (s) =>
        s.atMs >= first.atMs &&
        (s.total !== progress.total || s.planVersion !== progress.planVersion),
    )
  )
    return { ...unknown, state: "replanned", fromAt: first.at };
  return { ...unknown, state: "measured", doneDelta: progress.done - first.done, fromAt: first.at };
}
export function sampleProgress(
  tasks: readonly DashboardTask[],
  previous: readonly ProgressSample[],
  now: string,
): ProgressSample[] {
  const samples = previous.filter(
    (s) => Date.parse(s.at) >= Date.parse(now) - 3 * MOVEMENT_WINDOW_MS,
  );
  const latest = new Map(samples.map((s) => [s.taskId, s]));
  for (const task of tasks) {
    const last = latest.get(task.id);
    if (
      task.progress &&
      (!last ||
        Date.parse(now) - Date.parse(last.at) >= 60_000 ||
        last.done !== task.progress.done ||
        last.total !== task.progress.total ||
        last.planVersion !== task.progress.planVersion)
    ) {
      const sample = {
        taskId: task.id,
        at: now,
        done: task.progress.done,
        total: task.progress.total,
        planVersion: task.progress.planVersion,
      };
      samples.push(sample);
      latest.set(task.id, sample);
    }
  }
  return samples.slice(-30_000);
}
export function emptySnapshot(now: string): DashboardSnapshot {
  return { revision: 0, asOf: now, projects: [], releases: [], sources: [] };
}
export function issueId(host: string, repository: string, number: number) {
  return `issue:${host}/${repository}#${number}`;
}

/** Keep the summary bounded; the existing task detail API retains the full records. */
export function compactSnapshot(snapshot: DashboardSnapshot, maxBytes = 95_000): DashboardSnapshot {
  let budget =
    maxBytes -
    new TextEncoder().encode(
      JSON.stringify({
        ...snapshot,
        projects: snapshot.projects.map((p) => ({
          ...p,
          tasks: [],
          attention: [],
          workstreams: [],
          omittedWorkstreamCount: 0,
        })),
      }),
    ).length;
  const projects = snapshot.projects.map((project, index) => {
    let projectBudget = Math.max(0, Math.floor(budget / (snapshot.projects.length - index)));
    const tasks: DashboardTask[] = [];
    const headers = new Map(
      project.workstreams.map((workstream) => [
        workstream.id,
        {
          workstream,
          size:
            new TextEncoder().encode(JSON.stringify({ ...workstream, taskIds: [] })).length + 16,
        },
      ]),
    );
    const keptWorkstreams = new Set<string>();
    const ordered = [...project.tasks].sort(
      (a, b) => Number(b.attentionIds.length > 0) - Number(a.attentionIds.length > 0),
    );
    for (const task of ordered) {
      const header = headers.get(task.workstreamId);
      const size =
        new TextEncoder().encode(JSON.stringify(task)).length +
        200 +
        new TextEncoder().encode(JSON.stringify(task.id)).length +
        (header && !keptWorkstreams.has(task.workstreamId) ? header.size : 0) +
        project.attention
          .filter((a) => a.taskId === task.id)
          .reduce((total, a) => total + new TextEncoder().encode(JSON.stringify(a)).length, 0);
      if (projectBudget >= size && tasks.length < 100) {
        tasks.push(task);
        if (header) keptWorkstreams.add(task.workstreamId);
        budget -= size;
        projectBudget -= size;
      }
    }
    // Header-only workstreams use the remaining budget after actionable task/decision rows.
    for (const [id, header] of headers) {
      if (
        keptWorkstreams.has(id) ||
        header.workstream.progress === undefined ||
        projectBudget < header.size
      )
        continue;
      keptWorkstreams.add(id);
      budget -= header.size;
      projectBudget -= header.size;
    }
    const workstreams = project.workstreams.filter((workstream) =>
      keptWorkstreams.has(workstream.id),
    );
    const kept = new Set(tasks.map((t) => t.id));
    const attention = project.attention.filter((a) => kept.has(a.taskId));
    const shownAttention = new Set(attention.map((a) => a.id));
    return {
      ...project,
      omittedTaskCount: project.omittedTaskCount + project.tasks.length - tasks.length,
      omittedWorkstreamCount:
        (project.omittedWorkstreamCount ?? 0) + project.workstreams.length - workstreams.length,
      tasks: tasks.map((t) => ({
        ...t,
        attentionIds: t.attentionIds.filter((id) => shownAttention.has(id)),
      })),
      attention,
      workstreams: workstreams
        .map((w) => ({ ...w, taskIds: w.taskIds.filter((id) => kept.has(id)) }))
        .filter((w) => w.taskIds.length > 0 || w.progress !== undefined),
    };
  });
  return { ...snapshot, projects };
}
