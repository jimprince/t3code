import type { EnvironmentThreadShell } from "./state/models.ts";
import { supervisionKey } from "./state/forkNesting.ts";

/** Waiting children add an action to their organizational ancestors, never a runtime state. */
export function groupSupervisionChildInputAttention(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  parents: ReadonlyMap<string, string | null>,
) {
  const groups = new Map<string, EnvironmentThreadShell[]>();
  const byKey = new Map(
    threads.map((thread) => [supervisionKey(thread.environmentId, thread.id), thread]),
  );
  for (const child of threads) {
    if (
      !child.hasPendingUserInput ||
      child.archivedAt ||
      child.deletedAt ||
      child.settledOverride === "settled"
    )
      continue;
    const seen = new Set([supervisionKey(child.environmentId, child.id)]);
    let parentKey = parents.get(supervisionKey(child.environmentId, child.id)) ?? null;
    while (parentKey !== null && !seen.has(parentKey)) {
      seen.add(parentKey);
      const parent = byKey.get(parentKey);
      if (!parent || parent.archivedAt || parent.deletedAt || parent.settledOverride === "settled")
        break;
      const waiting = groups.get(parentKey) ?? [];
      waiting.push(child);
      groups.set(parentKey, waiting);
      parentKey = parents.get(parentKey) ?? null;
    }
  }
  return groups;
}

/** Existing sidebar consumers share the organizational traversal. */
export const groupChildInputAttention = groupSupervisionChildInputAttention;
