import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  supervisionIsActive,
  supervisionNeedsAttention,
  supervisionThreadKey,
} from "@t3tools/client-runtime/state/fork-nesting";

export type SupervisionGroup = {
  key: string;
  kind: "quiet" | "burst";
  children: ReadonlyArray<EnvironmentThreadShell>;
};
/** Quiet groups are reversible; active/open/pinned paths never disappear into a group. */
export function groupQuietChildren(input: {
  children: ReadonlyArray<EnvironmentThreadShell>;
  parentKey: string;
  visiblePaths: ReadonlySet<string>;
  activeCounts: ReadonlyMap<string, number>;
}) {
  const visible: EnvironmentThreadShell[] = [];
  const quiet: EnvironmentThreadShell[] = [];
  for (const child of input.children) {
    const key = supervisionThreadKey(child);
    if (
      child.pinnedAt !== null ||
      supervisionIsActive(child) ||
      supervisionNeedsAttention(child) ||
      input.visiblePaths.has(key) ||
      (input.activeCounts.get(key) ?? 0) > 0
    )
      visible.push(child);
    else quiet.push(child);
  }
  const untouched = quiet
    .filter(
      (t) =>
        t.latestRun === null &&
        t.updatedAt === t.createdAt &&
        Number.isFinite(Date.parse(t.createdAt)),
    )
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bursts: EnvironmentThreadShell[][] = [];
  let current: EnvironmentThreadShell[] = [];
  let start = 0;
  for (const child of untouched) {
    const time = Date.parse(child.createdAt);
    if (current.length > 0 && time - start > 120000) {
      if (current.length > 1) bursts.push(current);
      current = [];
    }
    if (current.length === 0) start = time;
    current.push(child);
  }
  if (current.length > 1) bursts.push(current);
  const burstKeys = new Set(bursts.flatMap((group) => group.map(supervisionThreadKey)));
  const groups: SupervisionGroup[] = bursts.map((children) => ({
    key: `burst:${input.parentKey}:${children.map((t) => t.id).join(",")}`,
    kind: "burst",
    children,
  }));
  const done = quiet.filter((t) => !burstKeys.has(supervisionThreadKey(t)));
  if (done.length > 0)
    groups.push({ key: `done:${input.parentKey}`, kind: "quiet", children: done });
  return { visible, groups };
}

export function supervisionProjectLabel(
  child: EnvironmentThreadShell,
  parent: EnvironmentThreadShell,
): string | null {
  return child.projectId === parent.projectId && child.environmentId === parent.environmentId
    ? null
    : child.projectId;
}
