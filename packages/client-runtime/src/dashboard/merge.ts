import * as DateTime from "effect/DateTime";
import type {
  DashboardSnapshot,
  DashboardSource,
  EnvironmentId,
  ThreadFilePlan,
} from "@t3tools/contracts";

/** The key of one thread's file plan in a merged dashboard. */
export const filePlanKey = (environmentId: string, threadId: string) =>
  `${environmentId}:${threadId}`;

/** Environment-qualified source ids keep every task's age tied to its own server. */
export function mergeDashboardSnapshots(
  parts: readonly { environmentId: EnvironmentId; snapshot: DashboardSnapshot | null }[],
) {
  const present = parts.filter(
    (part): part is { environmentId: EnvironmentId; snapshot: DashboardSnapshot } =>
      part.snapshot !== null,
  );
  const candidates = present.flatMap(({ environmentId, snapshot }) =>
    snapshot.projects.flatMap((project) =>
      project.attention.map((attention) => ({
        environmentId,
        project,
        attention,
        ownsThread:
          attention.kind === "decision" &&
          attention.threadId !== null &&
          project.tasks.some(
            (task) => task.id === attention.taskId && task.threadId === attention.threadId,
          ),
      })),
    ),
  );
  // Tracker reads overlap across hosts. Prefer a task linked to the decision's waiting thread,
  // rather than whichever environment happens to sort first.
  const chosen = new Map<string, (typeof candidates)[number]>();
  for (const candidate of candidates) {
    const prior = chosen.get(candidate.attention.id);
    if (!prior || (candidate.ownsThread && !prior.ownsThread))
      chosen.set(candidate.attention.id, candidate);
  }
  const sourceKey = (env: EnvironmentId, id: string) => `${env}:${id}`;
  const planMigration = present.flatMap(({ environmentId, snapshot }) =>
    (snapshot.planMigration ?? []).map((warning) => ({ ...warning, environmentId })),
  );
  return {
    ...(planMigration.length ? { planMigration } : {}),
    asOf: present.length
      ? DateTime.formatIso(
          DateTime.makeUnsafe(Math.max(...present.map((p) => Date.parse(p.snapshot.asOf)))),
        )
      : null,
    projects: present.flatMap(({ environmentId, snapshot }) =>
      snapshot.projects.map((project) => {
        const attention = project.attention
          .filter(
            (a) =>
              chosen.get(a.id)?.attention === a &&
              chosen.get(a.id)?.environmentId === environmentId,
          )
          .map((a) => ({ ...a, sourceId: sourceKey(environmentId, a.sourceId) }));
        return {
          key: `${environmentId}:${project.id}`,
          environmentId,
          project: {
            ...project,
            sourceIds: project.sourceIds.map((id) => sourceKey(environmentId, id)),
            attention,
            workstreams: project.workstreams.map((workstream) => ({
              ...workstream,
              ...(workstream.progress
                ? {
                    progress: {
                      ...workstream.progress,
                      sourceId: sourceKey(environmentId, workstream.progress.sourceId),
                    },
                  }
                : {}),
            })),
            tasks: project.tasks.map((t) => ({
              ...t,
              sourceId: sourceKey(environmentId, t.sourceId),
              progress: t.progress
                ? { ...t.progress, sourceId: sourceKey(environmentId, t.progress.sourceId) }
                : null,
              forecast: t.forecast
                ? { ...t.forecast, sourceId: sourceKey(environmentId, t.forecast.sourceId) }
                : null,
            })),
          },
        };
      }),
    ),
    releases: present.flatMap(({ environmentId, snapshot }) =>
      snapshot.releases.map((release) => ({
        environmentId,
        release: { ...release, sourceId: sourceKey(environmentId, release.sourceId) },
      })),
    ),
    // PLAN.md progress per thread, keyed by environment: the same thread id may exist on two servers.
    filePlans: Object.fromEntries(
      present.flatMap(({ environmentId, snapshot }) =>
        Object.entries(snapshot.filePlans ?? {}).map(([threadId, plan]) => [
          filePlanKey(environmentId, threadId),
          plan,
        ]),
      ),
    ) as Readonly<Record<string, ThreadFilePlan>>,
    sources: present.flatMap(({ environmentId, snapshot }) => {
      const used = new Set([
        ...snapshot.projects.flatMap((p) => p.sourceIds),
        ...snapshot.releases.map((r) => r.sourceId),
        ...snapshot.sources.filter((s) => s.detail).map((s) => s.id),
      ]);
      return snapshot.sources
        .filter((s) => used.has(s.id))
        .map((s) => ({ ...s, id: sourceKey(environmentId, s.id) }));
    }) as readonly DashboardSource[],
  };
}

/** Reuse a merge while each environment still supplies the same immutable snapshot. */
export function createDashboardSnapshotMerger() {
  type Parts = Parameters<typeof mergeDashboardSnapshots>[0];
  let previousParts: Parts = [];
  let previous: ReturnType<typeof mergeDashboardSnapshots> | undefined;
  return (parts: Parts) => {
    if (
      previous &&
      previousParts.length === parts.length &&
      parts.every(
        (part, i) =>
          part.environmentId === previousParts[i]!.environmentId &&
          part.snapshot === previousParts[i]!.snapshot,
      )
    )
      return previous;
    previousParts = parts;
    return (previous = mergeDashboardSnapshots(parts));
  };
}

/** A successful local answer remains hidden until the source confirms removal (bounded recovery). */
export function overlayAnswered(
  snapshot: DashboardSnapshot,
  answered: ReadonlyMap<string, number>,
  now: number,
): DashboardSnapshot {
  const hidden = new Set([...answered].filter(([, at]) => now - at < 5 * 60_000).map(([id]) => id));
  // Nothing in the snapshot to hide: keep its identity so downstream memoization and renders hold.
  const touched = snapshot.projects.some(
    (p) =>
      p.attention.some((a) => hidden.has(a.id)) ||
      p.tasks.some((t) => t.attentionIds.some((id) => hidden.has(id))),
  );
  if (!touched) return snapshot;
  return {
    ...snapshot,
    projects: snapshot.projects.map((p) => ({
      ...p,
      attention: p.attention.filter((a) => !hidden.has(a.id)),
      tasks: p.tasks.map((t) => ({
        ...t,
        attentionIds: t.attentionIds.filter((id) => !hidden.has(id)),
      })),
    })),
  };
}

/** Numeric segments cover nightly dates/runs and fork suffixes, ignoring the tag's v prefix. */
export function compareDashboardVersions(installed: string, latest: string): number {
  const left = installed.replace(/^v/, "");
  const right = latest.replace(/^v/, "");
  const core = /^(\d+\.\d+\.\d+)(?:-(.+))?$/;
  const leftCore = core.exec(left);
  const rightCore = core.exec(right);
  if (leftCore?.[1] === rightCore?.[1] && leftCore && rightCore) {
    if (!leftCore[2] && rightCore[2]) return 1;
    if (leftCore[2] && !rightCore[2]) return -1;
  }
  const a = left.match(/\d+|[^\d]+/g) ?? [];
  const b = right.match(/\d+|[^\d]+/g) ?? [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    const order = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (order) return Math.sign(order);
  }
  return 0;
}
