import type { EnvironmentId } from "@t3tools/contracts";

/** Collapsed widget ids live in this device's storage, one list per project page. */
export const collapsedWidgetsKey = (environmentId: EnvironmentId, rootThreadId: string) =>
  `t3code:projects:collapsed:${environmentId}:${rootThreadId}`;

/** The list with `id` added if it was missing, removed if it was there. */
export function toggleCollapsed(ids: ReadonlyArray<string>, id: string): ReadonlyArray<string> {
  return ids.includes(id) ? ids.filter((candidate) => candidate !== id) : [...ids, id];
}
