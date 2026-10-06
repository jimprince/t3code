import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { supervisionForest, supervisionKey } from "@t3tools/client-runtime/state/forkNesting";

export type SupervisionDragIntent = { kind: "reorder" } | { kind: "nest"; parentKey: string };
export function canSupervise(
  forest: ReturnType<typeof supervisionForest>,
  sourceKey: string,
  parentKey: string,
): boolean {
  const source = forest.byKey.get(sourceKey),
    parent = forest.byKey.get(parentKey);
  if (
    !source ||
    !parent ||
    sourceKey === parentKey ||
    source.environmentId !== parent.environmentId
  )
    return false;
  const seen = new Set<string>();
  let current: string | undefined = parentKey;
  while (current !== undefined && !seen.has(current)) {
    if (current === sourceKey) return false;
    seen.add(current);
    current = forest.parentByKey.get(current);
  }
  return true;
}
/** Hysteresis keeps a stationary pointer from switching intent on layout changes. */
export function supervisionDragIntent(input: {
  previous: SupervisionDragIntent;
  dx: number;
  sourceKey: string;
  overKey: string | null;
  forest: ReturnType<typeof supervisionForest>;
}): SupervisionDragIntent {
  const threshold = input.previous.kind === "nest" ? 6 : 12;
  if (
    input.dx < threshold ||
    input.overKey === null ||
    !canSupervise(input.forest, input.sourceKey, input.overKey)
  )
    return { kind: "reorder" };
  return { kind: "nest", parentKey: input.overKey };
}
export function directSiblingBucket(
  forest: ReturnType<typeof supervisionForest>,
  source: EnvironmentThreadShell,
) {
  const parent = forest.parentByKey.get(supervisionKey(source));
  return (parent === undefined ? [] : (forest.children.get(parent) ?? [])).filter(
    (t) => (t.pinnedAt !== null) === (source.pinnedAt !== null),
  );
}
