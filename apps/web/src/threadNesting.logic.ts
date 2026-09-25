import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem, EnvironmentId, ThreadId } from "@t3tools/contracts";

/**
 * Pure rules for nested threads on web and desktop. A nested thread leaves the
 * sidebar and is listed in its parent's Agents panel. The server enforces the
 * shape (one level, same project); these helpers only decide presentation and
 * which nesting actions to offer, and they never hide a thread whose parent
 * the user cannot reach.
 */
type NestingThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "projectId" | "parentThreadId" | "archivedAt"
>;

const threadKey = (thread: Pick<NestingThread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/**
 * Ids of threads nested right now within one environment's thread list: the
 * parent is present in the same project, not archived, and itself top-level.
 * A thread whose parent is archived, deleted, or unknown is not nested, so it
 * falls back to the sidebar instead of being stranded.
 */
export function resolveNestedThreadIds(
  threads: ReadonlyArray<Omit<NestingThread, "environmentId">>,
): Set<ThreadId> {
  const byId = new Map(threads.map((thread) => [thread.id, thread] as const));
  const nested = new Set<ThreadId>();
  for (const thread of threads) {
    if (thread.parentThreadId == null) continue;
    const parent = byId.get(thread.parentThreadId);
    if (
      parent !== undefined &&
      parent.id !== thread.id &&
      parent.projectId === thread.projectId &&
      parent.archivedAt === null &&
      parent.parentThreadId == null
    ) {
      nested.add(thread.id);
    }
  }
  return nested;
}

/** Scoped keys of nested threads across environments. Parents never match across environments. */
export function resolveNestedThreadKeys(threads: ReadonlyArray<NestingThread>): Set<string> {
  const byEnvironment = new Map<EnvironmentId, NestingThread[]>();
  for (const thread of threads) {
    const group = byEnvironment.get(thread.environmentId);
    if (group) group.push(thread);
    else byEnvironment.set(thread.environmentId, [thread]);
  }
  const nested = new Set<string>();
  for (const [environmentId, group] of byEnvironment) {
    for (const threadId of resolveNestedThreadIds(group)) {
      nested.add(scopedThreadKey(scopeThreadRef(environmentId, threadId)));
    }
  }
  return nested;
}

type AttentionThread = NestingThread &
  Pick<EnvironmentThreadShell, "hasPendingApprovals" | "hasPendingUserInput">;

/**
 * Sidebar input: drops nested threads and folds their pending approvals and
 * user input into the parent row, so attention never hides inside a parent.
 * Returns the input array itself when nothing is nested.
 */
export function applySidebarThreadNesting<T extends AttentionThread>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const nested = resolveNestedThreadKeys(threads);
  if (nested.size === 0) return threads;
  const attentionByParentKey = new Map<
    string,
    { hasPendingApprovals: boolean; hasPendingUserInput: boolean }
  >();
  for (const thread of threads) {
    if (thread.parentThreadId == null || thread.archivedAt !== null) continue;
    if (!nested.has(threadKey(thread))) continue;
    if (!thread.hasPendingApprovals && !thread.hasPendingUserInput) continue;
    const parentKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.parentThreadId));
    const current = attentionByParentKey.get(parentKey);
    attentionByParentKey.set(parentKey, {
      hasPendingApprovals: (current?.hasPendingApprovals ?? false) || thread.hasPendingApprovals,
      hasPendingUserInput: (current?.hasPendingUserInput ?? false) || thread.hasPendingUserInput,
    });
  }
  return threads.flatMap((thread) => {
    const key = threadKey(thread);
    if (nested.has(key)) return [];
    const attention = attentionByParentKey.get(key);
    if (
      attention === undefined ||
      ((thread.hasPendingApprovals || !attention.hasPendingApprovals) &&
        (thread.hasPendingUserInput || !attention.hasPendingUserInput))
    ) {
      return [thread];
    }
    return [
      {
        ...thread,
        hasPendingApprovals: thread.hasPendingApprovals || attention.hasPendingApprovals,
        hasPendingUserInput: thread.hasPendingUserInput || attention.hasPendingUserInput,
      },
    ];
  });
}

/**
 * The open thread when it is nested, with its parent's scoped key. The sidebar
 * shows it under that parent while it is open, so you can see where you are
 * and get back. Null when nothing nested is open.
 */
export function resolveViewedNestedThread<T extends NestingThread>(
  threads: ReadonlyArray<T>,
  viewedThreadKey: string | null,
): { readonly parentKey: string; readonly thread: T } | null {
  if (viewedThreadKey === null) return null;
  const viewed = threads.find((thread) => threadKey(thread) === viewedThreadKey);
  if (viewed === undefined || viewed.parentThreadId == null || viewed.archivedAt !== null) {
    return null;
  }
  if (!resolveNestedThreadKeys(threads).has(viewedThreadKey)) return null;
  return {
    parentKey: scopedThreadKey(scopeThreadRef(viewed.environmentId, viewed.parentThreadId)),
    thread: viewed,
  };
}

/** Whether `thread` is nested under `parent` right now (same rules as the sidebar). */
export function isNestedUnder(thread: NestingThread, parent: NestingThread): boolean {
  return (
    thread.parentThreadId === parent.id &&
    thread.environmentId === parent.environmentId &&
    resolveNestedThreadIds([thread, parent]).has(thread.id)
  );
}

/** Unarchived threads nested under `parent`, oldest first so rows keep their place. */
export function listNestedThreads<
  T extends NestingThread & Pick<EnvironmentThreadShell, "createdAt">,
>(
  threads: ReadonlyArray<T>,
  parent: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === parent.environmentId &&
        thread.parentThreadId === parent.threadId &&
        thread.id !== parent.threadId &&
        thread.archivedAt === null,
    )
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
}

/** Whether `thread` can be a parent: top-level and not archived. */
export function canParentThreads(thread: NestingThread): boolean {
  return thread.parentThreadId == null && thread.archivedAt === null;
}

const NEST_PARENT_CANDIDATE_LIMIT = 12;

/**
 * Threads `thread` may be nested under, most recently updated first. Mirrors
 * the server's rules so the menu only offers moves it will accept: same
 * environment and project, top-level, unarchived, and never when `thread`
 * already has nested threads of its own (archived children count).
 */
export function selectNestParentCandidates<
  T extends NestingThread & Pick<EnvironmentThreadShell, "updatedAt">,
>(thread: NestingThread, threads: ReadonlyArray<T>, limit = NEST_PARENT_CANDIDATE_LIMIT): T[] {
  const hasChildren = threads.some(
    (candidate) =>
      candidate.environmentId === thread.environmentId && candidate.parentThreadId === thread.id,
  );
  if (hasChildren) return [];
  return threads
    .filter(
      (candidate) =>
        candidate.environmentId === thread.environmentId &&
        candidate.projectId === thread.projectId &&
        candidate.id !== thread.id &&
        candidate.id !== thread.parentThreadId &&
        canParentThreads(candidate),
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
}

/** A pending "new thread under this one" draft, resolved at render and at send. */
export interface NestedDraftIntent {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
}

/**
 * The parent a nested draft will be created under, or null when the draft no
 * longer matches it (moved to another environment or project) or the parent
 * can no longer take children. Null means the draft sends as a normal thread.
 */
export function resolveNestedDraftParent<T extends NestingThread>(input: {
  readonly intent: NestedDraftIntent | null;
  readonly draft: Pick<NestingThread, "environmentId" | "projectId"> | null;
  readonly threads: ReadonlyArray<T>;
}): T | null {
  const { intent, draft } = input;
  if (intent === null || draft === null || intent.environmentId !== draft.environmentId) {
    return null;
  }
  const parent = input.threads.find(
    (thread) =>
      thread.environmentId === intent.environmentId && thread.id === intent.parentThreadId,
  );
  return parent !== undefined && parent.projectId === draft.projectId && canParentThreads(parent)
    ? parent
    : null;
}

export type ThreadNestingMenuId =
  | "new-nested-thread"
  | "nest-under"
  | `nest-under:${string}`
  | "move-to-sidebar";

export interface ThreadNestingMenuState {
  readonly canStartNestedThread: boolean;
  readonly isNested: boolean;
  readonly parentCandidates: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
}

/**
 * Nesting state for the per-thread action menu, or null when the server does
 * not support nesting and no item may show.
 */
export function resolveThreadNestingMenuState<
  T extends NestingThread & Pick<EnvironmentThreadShell, "updatedAt" | "title">,
>(thread: T, threads: ReadonlyArray<T>, supported: boolean): ThreadNestingMenuState | null {
  if (!supported) return null;
  return {
    canStartNestedThread: canParentThreads(thread),
    isNested: thread.parentThreadId != null,
    parentCandidates:
      thread.archivedAt === null
        ? selectNestParentCandidates(thread, threads).map(({ id, title }) => ({ id, title }))
        : [],
  };
}

export function isThreadNestingMenuId(id: string | null | undefined): id is ThreadNestingMenuId {
  return (
    id === "new-nested-thread" ||
    id === "nest-under" ||
    id === "move-to-sidebar" ||
    (id?.startsWith("nest-under:") ?? false)
  );
}

/** The parent chosen by a `nest-under:<id>` menu id, from the state the menu was built with. */
export function nestUnderMenuTarget(
  id: ThreadNestingMenuId,
  state: ThreadNestingMenuState | null,
): ThreadId | null {
  return (
    state?.parentCandidates.find((candidate) => `nest-under:${candidate.id}` === id)?.id ?? null
  );
}

/**
 * Splices nesting actions into the shared thread action menu: "New thread
 * under this one" joins the new-thread item at the top, and "Nest under…" /
 * "Move to sidebar" join the lifecycle group before Rename.
 */
export function withThreadNestingMenuItems<T extends string>(
  items: ReadonlyArray<ContextMenuItem<T>>,
  state: ThreadNestingMenuState | null,
): ReadonlyArray<ContextMenuItem<T | ThreadNestingMenuId>> {
  if (state === null) return items;
  const startItems: ContextMenuItem<ThreadNestingMenuId>[] = state.canStartNestedThread
    ? [{ id: "new-nested-thread", label: "New thread under this one", icon: "message-square-plus" }]
    : [];
  const placementItems: ContextMenuItem<ThreadNestingMenuId>[] = [
    ...(state.parentCandidates.length > 0
      ? [
          {
            id: "nest-under" as const,
            label: "Nest under…",
            children: state.parentCandidates.map((candidate) => ({
              id: `nest-under:${candidate.id}` as const,
              label: candidate.title,
            })),
          },
        ]
      : []),
    ...(state.isNested ? [{ id: "move-to-sidebar" as const, label: "Move to sidebar" }] : []),
  ];
  const result: ContextMenuItem<T | ThreadNestingMenuId>[] = [...items];
  const branchIndex = result.findIndex((item) => item.id === "new-thread-on-branch");
  result.splice(branchIndex + 1, 0, ...startItems);
  const renameIndex = result.findIndex((item) => item.id === "rename");
  result.splice(renameIndex === -1 ? result.length : renameIndex, 0, ...placementItems);
  return result;
}
