import {
  supervisionThreadKey,
  type supervisionForest,
} from "@t3tools/client-runtime/state/fork-nesting";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ContextMenuItem, ThreadId } from "@t3tools/contracts";
import { canSupervise } from "./sidebar/supervisionDragIntent";

const PARENT_CANDIDATE_LIMIT = 12;

export type ThreadNestingMenuId =
  | "new-nested-thread"
  | "nest-under"
  | `nest-under:${string}`
  | "move-to-sidebar"
  | "subproject-on"
  | "subproject-off";

export interface ThreadNestingMenuState {
  readonly canStartNestedThread: boolean;
  readonly isNested: boolean;
  /** Whether the thread owns workers, which already makes a top-level thread a project. */
  readonly ownsWorkers: boolean;
  /** Whether the thread is marked a project in its own right; null when the host cannot say. */
  readonly subproject: "on" | "off" | null;
  readonly parentCandidates: ReadonlyArray<{ readonly id: ThreadId; readonly title: string }>;
}

/**
 * Nesting state for the per-thread action menu, or null when the host cannot
 * nest and no item may show. Candidates mirror what a drag accepts: same
 * environment, never the thread itself, its current parent, or a descendant.
 */
export function resolveThreadNestingMenuState(input: {
  readonly thread: Pick<EnvironmentThreadShell, "environmentId" | "id">;
  readonly forest: ReturnType<typeof supervisionForest>;
  readonly supported: boolean;
  readonly subprojectsSupported?: boolean;
}): ThreadNestingMenuState | null {
  const { thread, forest } = input;
  if (!input.supported) return null;
  const key = supervisionThreadKey(thread);
  if (!forest.byKey.has(key)) return null;
  const currentParent = forest.parentByKey.get(key);
  return {
    canStartNestedThread: true,
    isNested: currentParent !== undefined,
    ownsWorkers: (forest.children.get(key) ?? []).length > 0,
    subproject:
      input.subprojectsSupported !== true
        ? null
        : forest.byKey.get(key)?.subproject === "on"
          ? "on"
          : "off",
    parentCandidates: [...forest.byKey.entries()]
      .filter(
        ([candidateKey]) =>
          candidateKey !== currentParent && canSupervise(forest, key, candidateKey),
      )
      .map(([, candidate]) => candidate)
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, PARENT_CANDIDATE_LIMIT)
      .map(({ id, title }) => ({ id, title })),
  };
}

export function isThreadNestingMenuId(id: string | null | undefined): id is ThreadNestingMenuId {
  return (
    id === "new-nested-thread" ||
    id === "nest-under" ||
    id === "move-to-sidebar" ||
    id === "subproject-on" ||
    id === "subproject-off" ||
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
 * The one item that moves a thread in or out of Projects. Nested, it reads as a
 * subproject of its parent. Top-level, it keeps a standing orchestrator in Projects
 * between jobs; a thread that already owns workers is a project either way, so the
 * item would claim to do nothing and is left out.
 */
function subprojectItems(
  state: ThreadNestingMenuState,
): ReadonlyArray<ContextMenuItem<ThreadNestingMenuId>> {
  if (state.subproject === null) return [];
  if (state.isNested) {
    return state.subproject === "on"
      ? [{ id: "subproject-off", label: "Show as worker" }]
      : [{ id: "subproject-on", label: "Show as subproject" }];
  }
  if (state.subproject === "on") return [{ id: "subproject-off", label: "Remove from Projects" }];
  return state.ownsWorkers ? [] : [{ id: "subproject-on", label: "Show in Projects" }];
}

/**
 * Splices nesting actions into the shared thread action menu: "New thread
 * under this one" joins the new-thread item at the top, and "Nest under…" /
 * "Move to sidebar" / "Show as subproject" join the lifecycle group before Rename.
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
    ...subprojectItems(state),
  ];
  const result: ContextMenuItem<T | ThreadNestingMenuId>[] = [...items];
  const branchIndex = result.findIndex((item) => item.id === "new-thread-on-branch");
  result.splice(branchIndex + 1, 0, ...startItems);
  const renameIndex = result.findIndex((item) => item.id === "rename");
  result.splice(renameIndex === -1 ? result.length : renameIndex, 0, ...placementItems);
  return result;
}
