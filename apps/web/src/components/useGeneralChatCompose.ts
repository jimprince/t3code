import { useCallback, useMemo, type MouseEvent as ReactMouseEvent } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { scopeProjectRef, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { Project } from "../types";
import type { useHandleNewThread } from "../hooks/useHandleNewThread";
import { readThreadShells } from "../state/entities";
import {
  selectCanonicalChatProjectsByEnvironment,
  selectRecentThreadProjectRef,
} from "../projectKind";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "../lib/chatThreadActions";
import { readLocalApi } from "../localApi";
import { openCommandPalette } from "../commandPaletteBus";
import { shouldCreateNewThreadInCurrentProject } from "./Sidebar.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

/** Shared Sidebar compose policy with explicit environment choice for General Chat. */
export function useGeneralChatCompose({
  chatProjects,
  projects,
  primaryEnvironmentId,
  environmentLabelById,
  newThreadContext,
  isMobile,
  setOpenMobile,
  projectGroupCount,
}: {
  chatProjects: readonly Project[];
  projects: readonly Project[];
  primaryEnvironmentId: EnvironmentId | null;
  environmentLabelById: ReadonlyMap<EnvironmentId, string>;
  newThreadContext: ReturnType<typeof useHandleNewThread>;
  isMobile: boolean;
  setOpenMobile: (open: boolean) => void;
  projectGroupCount: number;
}) {
  const { handleNewThread } = newThreadContext;
  const chatEnvironmentProjects = useMemo(
    () =>
      [...selectCanonicalChatProjectsByEnvironment(chatProjects)].sort((left, right) => {
        const leftIsPrimary = left.environmentId === primaryEnvironmentId;
        const rightIsPrimary = right.environmentId === primaryEnvironmentId;
        if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
        const leftLabel = environmentLabelById.get(left.environmentId) ?? "Remote environment";
        const rightLabel = environmentLabelById.get(right.environmentId) ?? "Remote environment";
        return leftLabel.localeCompare(rightLabel);
      }),
    [chatProjects, environmentLabelById, primaryEnvironmentId],
  );
  const createChatForProject = useCallback(
    (project: (typeof chatEnvironmentProjects)[number]) => {
      if (isMobile) setOpenMobile(false);
      void (async () => {
        const result = await settlePromise(() =>
          handleNewThread(scopeProjectRef(project.environmentId, project.id)),
        );
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create chat",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [handleNewThread, isMobile, setOpenMobile],
  );

  // New threads start where the user was last working: the open thread's or
  // draft's project, else the project they most recently messaged. General
  // Chat is the fallback; with multiple connected environments the desktop
  // shell then provides a compact environment picker, and browsers fall back
  // to the primary environment.
  const handleNewThreadClick = useCallback(
    (event: ReactMouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const lastWorkedContext = {
        activeDraftThread: newThreadContext.activeDraftThread,
        activeThread: newThreadContext.activeThread ?? undefined,
        defaultProjectRef: selectRecentThreadProjectRef(readThreadShells(), projects),
        handleNewThread: newThreadContext.handleNewThread,
      };
      if (resolveThreadActionProjectRef(lastWorkedContext)) {
        if (isMobile) setOpenMobile(false);
        void startNewThreadFromContext(lastWorkedContext);
        return;
      }
      const defaultChatProject = chatEnvironmentProjects[0];
      if (defaultChatProject) {
        if (chatEnvironmentProjects.length === 1) {
          createChatForProject(defaultChatProject);
          return;
        }
        void (async () => {
          const api = readLocalApi();
          if (!api) {
            createChatForProject(defaultChatProject);
            return;
          }
          const clickedResult = await settlePromise(() =>
            api.contextMenu.show(
              chatEnvironmentProjects.map((project) => ({
                id: scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
                label:
                  project.environmentId === primaryEnvironmentId
                    ? "This device"
                    : (environmentLabelById.get(project.environmentId) ?? "Remote environment"),
              })),
              { x: event.clientX, y: event.clientY },
            ),
          );
          if (clickedResult._tag === "Failure") {
            const error = squashAtomCommandFailure(clickedResult);
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: "Could not choose environment",
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
            return;
          }
          const selectedProject = chatEnvironmentProjects.find(
            (project) =>
              scopedProjectKey(scopeProjectRef(project.environmentId, project.id)) ===
              clickedResult.value,
          );
          if (selectedProject) createChatForProject(selectedProject);
        })();
        return;
      }

      // Without a chat project, retain upstream's contextual workspace flow.
      // One project: nothing to pick, create immediately. Shift+click creates
      // directly in the current project even with several projects, skipping
      // the palette picker.
      if (shouldCreateNewThreadInCurrentProject(event.shiftKey, projectGroupCount)) {
        if (isMobile) setOpenMobile(false);
        void startNewThreadFromContext({
          activeDraftThread: newThreadContext.activeDraftThread,
          activeThread: newThreadContext.activeThread ?? undefined,
          defaultProjectRef: newThreadContext.defaultProjectRef,
          handleNewThread: newThreadContext.handleNewThread,
        });
        return;
      }
      if (isMobile) setOpenMobile(false);
      openCommandPalette({ open: "new-thread-in" });
    },
    [
      chatEnvironmentProjects,
      createChatForProject,
      environmentLabelById,
      isMobile,
      newThreadContext,
      primaryEnvironmentId,
      projectGroupCount,
      projects,
      setOpenMobile,
    ],
  );

  return handleNewThreadClick;
}
