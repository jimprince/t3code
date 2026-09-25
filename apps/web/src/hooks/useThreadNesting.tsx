import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { CornerDownRightIcon, PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readThreadShell,
  readThreadShells,
  useServerConfigs,
  useThreadShell,
} from "../state/entities";
import { environmentServerConfigsAtom } from "../state/server";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  canParentThreads,
  type NestedDraftIntent,
  nestUnderMenuTarget,
  resolveNestedDraftParent,
  type ThreadNestingMenuId,
  type ThreadNestingMenuState,
} from "../threadNesting.logic";
import { useNewThreadHandler } from "./useHandleNewThread";

/** Whether the environment's server stores parentThreadId and accepts thread.parent.set. */
export function readEnvironmentSupportsThreadNesting(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadNesting === true
  );
}

/**
 * Drafts started with "New thread under this one", by draft id. Session-only:
 * after a reload the draft sends as a normal top-level thread, which the user
 * can still nest from the thread menu.
 */
const useNestedDraftStore = create<{
  readonly intents: Readonly<Partial<Record<DraftId, NestedDraftIntent>>>;
}>(() => ({ intents: {} }));

function setNestedDraftIntent(draftId: DraftId, intent: NestedDraftIntent | null) {
  useNestedDraftStore.setState(({ intents }) => {
    const next = { ...intents };
    if (intent === null) delete next[draftId];
    else next[draftId] = intent;
    return { intents: next };
  });
}

type DraftTarget = Pick<EnvironmentThreadShell, "environmentId" | "projectId">;

/**
 * Extra bootstrap.createThread fields for a draft being sent: its parent when
 * it was started under one and that parent can still take it. Read at send
 * time so a parent archived meanwhile degrades to a top-level thread instead
 * of a rejected send.
 */
export function nestedDraftCreateThreadFields(
  draftId: DraftId | null,
  draft: DraftTarget,
): { readonly parentThreadId?: ThreadId } {
  if (draftId === null || !readEnvironmentSupportsThreadNesting(draft.environmentId)) return {};
  const parent = resolveNestedDraftParent({
    intent: useNestedDraftStore.getState().intents[draftId] ?? null,
    draft,
    threads: readThreadShells(),
  });
  return parent === null ? {} : { parentThreadId: parent.id };
}

/**
 * Composer notice on a nested draft, naming the parent it will be created
 * under, with the way out.
 */
export function useNestedDraftBannerItem(
  draftId: DraftId | null,
  draft: DraftTarget | null,
): ComposerBannerStackItem | null {
  const intent = useNestedDraftStore((state) =>
    draftId === null ? null : (state.intents[draftId] ?? null),
  );
  const parentShell = useThreadShell(
    intent === null ? null : scopeThreadRef(intent.environmentId, intent.parentThreadId),
  );
  const parent = resolveNestedDraftParent({
    intent,
    draft,
    threads: parentShell === null ? [] : [parentShell],
  });
  const parentTitle = parent?.title ?? null;
  // Leaving a nested draft while it is still empty drops the intent. The
  // project reuses its empty draft for the next plain "New thread", which must
  // not inherit the parent.
  useEffect(() => {
    if (draftId === null) return;
    return () => {
      const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
      if (!composerDraftHasUserContent(draft)) setNestedDraftIntent(draftId, null);
    };
  }, [draftId]);
  return useMemo(() => {
    if (draftId === null || parentTitle === null) return null;
    return {
      id: `nested-draft:${draftId}`,
      variant: "info",
      icon: <CornerDownRightIcon />,
      title: `Nests under ${parentTitle}`,
      description: "Sending creates this thread in its Agents panel",
      actions: (
        <Button size="xs" variant="ghost" onClick={() => setNestedDraftIntent(draftId, null)}>
          Don't nest
        </Button>
      ),
    };
  }, [draftId, parentTitle]);
}

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

/** Nesting actions shared by the sidebar, the thread header menu, the palette, and the Agents panel. */
export function useThreadNestingActions() {
  const setParent = useAtomCommand(threadEnvironment.setParent, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  /** Nests `threadRef` under `parentThreadId`, or with null returns it to the sidebar. */
  const setThreadParent = useCallback(
    async (threadRef: ScopedThreadRef, parentThreadId: ThreadId | null): Promise<void> => {
      if (!readEnvironmentSupportsThreadNesting(threadRef.environmentId)) {
        failureToast(
          "Nesting unavailable",
          new Error("Update this environment's server to nest threads."),
        );
        return;
      }
      const dispatch = async (nextParentThreadId: ThreadId | null) => {
        const result = await setParent({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, parentThreadId: nextParentThreadId },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast(
            nextParentThreadId === null
              ? "Failed to move thread to sidebar"
              : "Failed to nest thread",
            squashAtomCommandFailure(result),
          );
        }
        return result._tag === "Success";
      };
      const previousParentThreadId = readThreadShell(threadRef)?.parentThreadId ?? null;
      if (!(await dispatch(parentThreadId)) || parentThreadId === null) return;
      // The row leaves the sidebar, so say where it went and offer the way back.
      const parentTitle =
        readThreadShell(scopeThreadRef(threadRef.environmentId, parentThreadId))?.title ??
        "its parent";
      const toastId = toastManager.add({
        type: "success",
        title: `Nested under ${parentTitle}`,
        description: "Find it in that thread's Agents panel.",
        actionProps: {
          children: "Undo",
          onClick: () => {
            toastManager.close(toastId);
            void dispatch(previousParentThreadId);
          },
        },
      });
    },
    [setParent],
  );

  /**
   * Opens a draft in the parent's project and environment whose first send
   * creates it nested under `parentRef`.
   */
  const startNestedThread = useCallback(
    async (parentRef: ScopedThreadRef): Promise<void> => {
      const parent = readThreadShell(parentRef);
      if (!parent) return;
      const projectRef = scopeProjectRef(parent.environmentId, parent.projectId);
      const result = await settlePromise(() => handleNewThread(projectRef));
      if (result._tag === "Failure") {
        failureToast("Could not create thread", squashAtomCommandFailure(result));
        return;
      }
      if (result.value === null) return;
      // Nesting is same-environment, so keep automatic routing from moving the draft.
      useComposerDraftStore.getState().setDraftThreadContext(result.value.draftId, {
        projectRef,
        environmentSelection: "manual",
        loadBalancedEnvironmentId: null,
      });
      setNestedDraftIntent(result.value.draftId, {
        environmentId: parent.environmentId,
        parentThreadId: parent.id,
      });
    },
    [handleNewThread],
  );

  /** Runs a nesting item picked from the thread action menu built with `state`. */
  const runNestingMenuAction = useCallback(
    async (
      threadRef: ScopedThreadRef,
      id: ThreadNestingMenuId,
      state: ThreadNestingMenuState | null,
    ): Promise<void> => {
      if (id === "new-nested-thread") return startNestedThread(threadRef);
      if (id === "move-to-sidebar") return setThreadParent(threadRef, null);
      const parentThreadId = nestUnderMenuTarget(id, state);
      if (parentThreadId !== null) await setThreadParent(threadRef, parentThreadId);
    },
    [setThreadParent, startNestedThread],
  );

  return useMemo(
    () => ({ setThreadParent, startNestedThread, runNestingMenuAction }),
    [runNestingMenuAction, setThreadParent, startNestedThread],
  );
}

/**
 * Command palette actions for the thread being viewed: start a nested thread,
 * or move it back to the sidebar. The palette rebuilds its list every render,
 * so this returns a fresh array too.
 */
export function useThreadNestingPaletteItems(
  thread: Pick<
    EnvironmentThreadShell,
    "id" | "environmentId" | "projectId" | "parentThreadId" | "archivedAt"
  > | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const { setThreadParent, startNestedThread } = useThreadNestingActions();
  const serverConfigs = useServerConfigs();
  if (
    thread === null ||
    serverConfigs.get(thread.environmentId)?.environment.capabilities.threadNesting !== true
  ) {
    return [];
  }
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const items: CommandPaletteActionItem[] = [];
  if (canParentThreads(thread)) {
    items.push({
      kind: "action",
      value: "action:new-nested-thread",
      searchTerms: ["new thread", "nest", "nested", "child", "under", "subthread"],
      title: "New thread under this one",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: () => startNestedThread(threadRef),
    });
  }
  if (thread.parentThreadId != null) {
    items.push({
      kind: "action",
      value: "action:move-thread-to-sidebar",
      searchTerms: ["move to sidebar", "unnest", "nested", "parent"],
      title: "Move thread to sidebar",
      icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      run: () => setThreadParent(threadRef, null),
    });
  }
  return items;
}
