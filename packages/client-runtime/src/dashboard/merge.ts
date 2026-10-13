import * as DateTime from "effect/DateTime";
import type { DashboardSnapshot, DashboardSource, EnvironmentId } from "@t3tools/contracts";

/** Environment-qualified source ids keep every task's age tied to its own server. */
export function mergeDashboardSnapshots(
  parts: readonly { environmentId: EnvironmentId; snapshot: DashboardSnapshot | null }[],
) {
  const present = parts.filter(
    (part): part is { environmentId: EnvironmentId; snapshot: DashboardSnapshot } =>
      part.snapshot !== null,
  );
  const seen = new Set<string>();
  const sourceKey = (env: EnvironmentId, id: string) => `${env}:${id}`;
  return {
    asOf: present.length
      ? DateTime.formatIso(
          DateTime.makeUnsafe(Math.max(...present.map((p) => Date.parse(p.snapshot.asOf)))),
        )
      : null,
    projects: present.flatMap(({ environmentId, snapshot }) =>
      snapshot.projects.map((project) => {
        const attention = project.attention
          .filter((a) => {
            if (seen.has(a.id)) return false;
            seen.add(a.id);
            return true;
          })
          .map((a) => ({ ...a, sourceId: sourceKey(environmentId, a.sourceId) }));
        return {
          key: `${environmentId}:${project.id}`,
          environmentId,
          project: {
            ...project,
            sourceIds: project.sourceIds.map((id) => sourceKey(environmentId, id)),
            attention,
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

/** A successful local answer remains hidden until the source confirms removal (bounded recovery). */
export function overlayAnswered(
  snapshot: DashboardSnapshot,
  answered: ReadonlyMap<string, number>,
  now: number,
): DashboardSnapshot {
  const hidden = new Set([...answered].filter(([, at]) => now - at < 5 * 60_000).map(([id]) => id));
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
