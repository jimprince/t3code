import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { supervisionThreadKey } from "@t3tools/client-runtime/state/fork-nesting";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { CornerDownRightIcon, PanelLeftIcon, SquarePenIcon } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";

import type { ComposerBannerStackItem } from "../components/chat/ComposerBannerStack";
import { readForkNestingSupported } from "../components/chat/forkThreadCommands";
import { setThreadSubprojectCommand } from "../state/forkSubproject";
import { type CommandPaletteActionItem, ITEM_ICON_CLASS } from "../components/CommandPalette.logic";
import { Button } from "../components/ui/button";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  nestUnderMenuTarget,
  type ThreadNestingMenuId,
  type ThreadNestingMenuState,
} from "../components/threadNestingMenu.logic";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type DraftId,
} from "../composerDraftStore";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { readThreadShell, useThreadShell } from "../state/entities";
import {
  supervision,
  supervisionDropCommand,
  useSupervisionForest,
} from "../state/forkSupervision";
import { useAtomCommand } from "../state/use-atom-command";
import { useNewThreadHandler } from "./useHandleNewThread";

interface NestedDraftIntent {
  readonly environmentId: EnvironmentId;
  readonly parentThreadId: ThreadId;
}

/**
 * Drafts started with "New thread under this one", by draft id. Session-only:
 * after a reload the draft sends as a normal top-level thread, which can still
 * be nested from the thread menu.
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

/** The draft's parent if it can still take children, read at send time so an archived parent degrades to top level. */
function resolveNestedDraftParent(draftId: DraftId, environmentId: EnvironmentId) {
  const intent = useNestedDraftStore.getState().intents[draftId];
  if (intent === undefined || intent.environmentId !== environmentId) return null;
  return (
    appAtomRegistry
      .get(supervision.forest)
      .byKey.get(supervisionThreadKey({ environmentId, id: intent.parentThreadId })) ?? null
  );
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

/**
 * Composer notice on a nested draft, naming the parent it will be created
 * under, with the way out.
 */
export function useNestedDraftBannerItem(
  draftId: DraftId | null,
  environmentId: EnvironmentId | null,
): ComposerBannerStackItem | null {
  const intent = useNestedDraftStore((state) =>
    draftId === null ? null : (state.intents[draftId] ?? null),
  );
  const parentShell = useThreadShell(
    intent === null ? null : scopeThreadRef(intent.environmentId, intent.parentThreadId),
  );
  const parentTitle =
    intent !== null && environmentId === intent.environmentId && parentShell?.archivedAt === null
      ? parentShell.title
      : null;
  // The project reuses its empty draft for the next plain "New thread", which must not inherit the parent.
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
      actions: (
        <Button size="compact" variant="ghost" onClick={() => setNestedDraftIntent(draftId, null)}>
          Don't nest
        </Button>
      ),
    };
  }, [draftId, parentTitle]);
}

/** Nesting actions shared by the sidebar menu, the thread header menu, and the details panel. */
export function useThreadNestingActions() {
  const drop = useAtomCommand(supervisionDropCommand, { reportFailure: false });
  const setSubproject = useAtomCommand(setThreadSubprojectCommand, { reportFailure: false });
  const handleNewThread = useNewThreadHandler();

  /** Nests `threadRef` under `parentThreadId`, or with null returns it to the sidebar. */
  const setThreadParent = useCallback(
    async (threadRef: ScopedThreadRef, parentThreadId: ThreadId | null): Promise<boolean> => {
      const dispatch = async (nextParentThreadId: ThreadId | null) => {
        const result = await drop({
          environmentId: threadRef.environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            threadId: threadRef.threadId,
            parentThreadId: nextParentThreadId,
          },
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
      const forest = appAtomRegistry.get(supervision.forest);
      const key = supervisionThreadKey({
        environmentId: threadRef.environmentId,
        id: threadRef.threadId,
      });
      const previousParent = forest.byKey.get(forest.parentByKey.get(key) ?? "");
      if (!(await dispatch(parentThreadId))) return false;
      if (parentThreadId === null) return true;
      // The row leaves the sidebar, so say where it went and offer the way back.
      const parentTitle =
        readThreadShell(scopeThreadRef(threadRef.environmentId, parentThreadId))?.title ??
        "its parent";
      const restorable =
        previousParent === undefined || previousParent.environmentId === threadRef.environmentId;
      const toastId = toastManager.add({
        type: "success",
        title: `Nested under ${parentTitle}`,
        ...(restorable
          ? {
              actionProps: {
                children: "Undo",
                onClick: () => {
                  toastManager.close(toastId);
                  void dispatch(previousParent?.id ?? null);
                },
              },
            }
          : {}),
      });
      return true;
    },
    [drop],
  );

  /** Opens a draft in the parent's project whose first send creates it nested under `parentRef`. */
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
      if (id === "move-to-sidebar") {
        await setThreadParent(threadRef, null);
        return;
      }
      if (id === "subproject-on" || id === "subproject-off") {
        const result = await setSubproject({
          environmentId: threadRef.environmentId,
          input: {
            commandId: CommandId.make(randomUUID()),
            threadId: threadRef.threadId,
            subproject: id === "subproject-on" ? "on" : "off",
          },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          failureToast("Failed to change subproject", squashAtomCommandFailure(result));
        }
        return;
      }
      const parentThreadId = nestUnderMenuTarget(id, state);
      if (parentThreadId !== null) await setThreadParent(threadRef, parentThreadId);
    },
    [setSubproject, setThreadParent, startNestedThread],
  );

  /** After a nested draft's first send creates its thread, files the new thread under the draft's parent. */
  const attachNestedDraft = useCallback(
    async (draftId: DraftId, threadRef: ScopedThreadRef): Promise<void> => {
      const parent = resolveNestedDraftParent(draftId, threadRef.environmentId);
      setNestedDraftIntent(draftId, null);
      if (parent !== null) await setThreadParent(threadRef, parent.id);
    },
    [setThreadParent],
  );

  return useMemo(
    () => ({ setThreadParent, startNestedThread, runNestingMenuAction, attachNestedDraft }),
    [attachNestedDraft, runNestingMenuAction, setThreadParent, startNestedThread],
  );
}

/**
 * Command palette actions for the thread being viewed: start a nested thread,
 * or move it back to the sidebar.
 */
export function useThreadNestingPaletteItems(
  thread: Pick<EnvironmentThreadShell, "id" | "environmentId"> | null,
): ReadonlyArray<CommandPaletteActionItem> {
  const { setThreadParent, startNestedThread } = useThreadNestingActions();
  const forest = useSupervisionForest();
  if (thread === null || !readForkNestingSupported(thread.environmentId)) return [];
  const key = supervisionThreadKey(thread);
  if (!forest.byKey.has(key)) return [];
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:new-nested-thread",
      searchTerms: ["new thread", "nest", "nested", "child", "under", "worker"],
      title: "New thread under this one",
      icon: <SquarePenIcon className={ITEM_ICON_CLASS} />,
      run: () => startNestedThread(threadRef),
    },
  ];
  if (forest.parentByKey.has(key)) {
    items.push({
      kind: "action",
      value: "action:move-thread-to-sidebar",
      searchTerms: ["move to sidebar", "unnest", "nested", "parent"],
      title: "Move to sidebar",
      icon: <PanelLeftIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        await setThreadParent(threadRef, null);
      },
    });
  }
  return items;
}
