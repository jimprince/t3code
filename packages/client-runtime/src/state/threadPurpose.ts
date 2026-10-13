import type { ThreadPurpose } from "@t3tools/contracts";
import type { OrchestratorSummary, OrchestratorThreadShell } from "./orchestrators.ts";
import { supervisionThreadKey } from "./forkNesting.ts";

export interface PurposeNode {
  readonly key: string;
  readonly parentKey: string | null;
  readonly purpose?: ThreadPurpose | null | undefined;
  readonly unavailable?: boolean;
}

/** Resolve the complete forest once; absent parents and cycles remain unknown. */
export function effectivePurpose(
  nodes: readonly PurposeNode[],
): ReadonlyMap<string, ThreadPurpose | null> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const resolved = new Map<string, ThreadPurpose | null>();
  for (const node of nodes) {
    if (resolved.has(node.key)) continue;
    const path: string[] = [];
    const seen = new Set<string>();
    let cursor: string | null = node.key;
    let purpose: ThreadPurpose | null = "project";
    while (cursor !== null) {
      if (resolved.has(cursor)) {
        purpose = resolved.get(cursor)!;
        break;
      }
      const current = byKey.get(cursor);
      if (!current || current.unavailable || seen.has(cursor)) {
        purpose = null;
        break;
      }
      path.push(cursor);
      seen.add(cursor);
      if (current.purpose != null) {
        purpose = current.purpose;
        break;
      }
      cursor = current.parentKey;
    }
    for (const key of path) resolved.set(key, purpose);
  }
  return resolved;
}

// Joined shell arrays are immutable forest revisions. Weak keys release disconnected forests.
const forestCache = new WeakMap<
  readonly OrchestratorThreadShell[],
  ReadonlyMap<string, ThreadPurpose | null>
>();
export function threadPurposes(threads: readonly OrchestratorThreadShell[]) {
  const cached = forestCache.get(threads);
  if (cached) return cached;
  const result = effectivePurpose(
    threads.map((thread) => ({
      key: supervisionThreadKey(thread),
      // Keep the raw edge: the navigation forest deliberately drops unavailable parents.
      parentKey: thread.remoteParent
        ? `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`
        : thread.parentThreadId != null
          ? `${thread.environmentId}:${thread.parentThreadId}`
          : thread.supervisionMetadataPresent !== true &&
              thread.lineage.relationshipToParent === "subagent" &&
              thread.lineage.parentThreadId != null
            ? `${thread.environmentId}:${thread.lineage.parentThreadId}`
            : null,
      purpose: thread.purpose,
      unavailable: thread.forkMetadataAvailable === false,
    })),
  );
  forestCache.set(threads, result);
  return result;
}

export type PurposeMoveId = "move-to-harness" | "move-to-projects" | "move-to-threads";
export interface PurposeMove {
  readonly id: PurposeMoveId;
  readonly label: string;
  /**
   * Written as the thread's own override; nesting, pin and settle are untouched. Null clears the
   * override, so the thread follows its supervisor again.
   */
  readonly purpose: ThreadPurpose | null;
}

/**
 * The one reversible move a thread offers between Harness and the rest, or null when it has none.
 * Only a top-level thread (or one that already carries its own override) moves; a worker follows
 * its root. Moving back says where the thread returns: Projects when it is project-shaped
 * (owns workers or is marked a project), Threads when it is a plain standalone thread. An
 * unknown purpose (remote ancestry not connected) offers nothing rather than a guess.
 */
export function purposeMoveFor(
  threads: readonly OrchestratorThreadShell[],
  key: string,
): PurposeMove | null {
  const thread = threads.find((candidate) => supervisionThreadKey(candidate) === key);
  if (!thread || thread.archivedAt !== null) return null;
  const effective = threadPurposes(threads).get(key) ?? null;
  if (effective === null) return null;
  if (purposeParentKey(thread) !== null && thread.purpose == null) return null;
  if (effective === "project") {
    return { id: "move-to-harness", label: "Move to Harness", purpose: "harness" };
  }
  const projectShaped =
    thread.subproject === "on" ||
    threads.some((other) => other.archivedAt === null && purposeParentKey(other) === key);
  // Clear the override when its supervisor (or the root default) already says project, so the
  // thread follows a later supervisor. Pin "project" only where it must stay out of a Harness
  // parent, or when the parent's purpose is not known yet.
  const parentKey = purposeParentKey(thread);
  const inherited =
    parentKey === null ? "project" : (threadPurposes(threads).get(parentKey) ?? null);
  const purpose = inherited === "project" ? null : "project";
  return projectShaped
    ? { id: "move-to-projects", label: "Move back to Projects", purpose }
    : { id: "move-to-threads", label: "Move back to Threads", purpose };
}

/**
 * The plain tag a subproject row carries when its purpose differs from its project's: "Harness"
 * for a Harness subproject listed in a project's card, null otherwise. Projects lists every active
 * subproject (organizational nesting is the truth); a Harness subproject is also a root of the
 * Harness tab, so the tag says why it sits in both places.
 */
export function subprojectPurposeTag(
  parent: OrchestratorSummary,
  sub: OrchestratorSummary,
  purposes: ReadonlyMap<string, ThreadPurpose | null>,
): "Harness" | null {
  return purposes.get(supervisionThreadKey(sub.root)) === "harness" &&
    purposes.get(supervisionThreadKey(parent.root)) !== "harness"
    ? "Harness"
    : null;
}

/** Partition after resolving all ancestry, preserving complete summaries for attention rollups. */
export function partitionThreadPurposes(
  threads: readonly OrchestratorThreadShell[],
  summaries: readonly OrchestratorSummary[],
) {
  const purposes = threadPurposes(threads);
  const projectKeys = new Set(summaries.map((summary) => supervisionThreadKey(summary.root)));
  const projects: OrchestratorSummary[] = [];
  const harness: Array<OrchestratorSummary | OrchestratorThreadShell> = [];
  const standalone: OrchestratorThreadShell[] = [];
  const unclassified: OrchestratorThreadShell[] = [];
  for (const summary of summaries) {
    const purpose = purposes.get(supervisionThreadKey(summary.root)) ?? null;
    const parent = summary.parentProjectKey;
    if (parent !== null && purposes.get(parent) === purpose) continue;
    if (purpose === "harness") harness.push(summary);
    else if (purpose === "project") projects.push(summary);
  }
  const byKey = new Map(threads.map((thread) => [supervisionThreadKey(thread), thread]));
  const owners = new Map<string, boolean>();
  const inProjectTree = (key: string) => {
    const path: string[] = [];
    const seen = new Set<string>();
    const purpose = purposes.get(key);
    let cursor: string | null = key;
    let owned = false;
    while (cursor !== null && !seen.has(cursor) && purposes.get(cursor) === purpose) {
      if (owners.has(cursor)) {
        owned = owners.get(cursor)!;
        break;
      }
      if (projectKeys.has(cursor)) {
        owned = true;
        break;
      }
      path.push(cursor);
      seen.add(cursor);
      const thread = byKey.get(cursor);
      cursor = thread?.remoteParent
        ? `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`
        : thread?.parentThreadId != null
          ? `${thread.environmentId}:${thread.parentThreadId}`
          : null;
    }
    for (const item of path) owners.set(item, owned);
    return owned;
  };
  for (const thread of threads) {
    if (thread.archivedAt !== null) continue;
    const key = supervisionThreadKey(thread);
    const purpose = purposes.get(key) ?? null;
    if (purpose === null) {
      unclassified.push(thread);
      continue;
    }
    if (projectKeys.has(key)) continue;
    if (inProjectTree(key)) continue;
    if (purpose === "harness") {
      const parentKey = thread.remoteParent
        ? `${thread.remoteParent.environmentId}:${thread.remoteParent.threadId}`
        : thread.parentThreadId == null
          ? null
          : `${thread.environmentId}:${thread.parentThreadId}`;
      if (parentKey === null || purposes.get(parentKey) !== purpose) harness.push(thread);
    } else standalone.push(thread);
  }
  return { projects, harness, standalone, unclassified, purposes };
}
