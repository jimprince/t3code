import { useCallback } from "react";

import {
  CommandId,
  type ModelSelection,
  type OrchestrationThread,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";

import { uuidv4 } from "../lib/uuid";
import { environmentRuntimeManager } from "./use-environment-runtime";
import { getEnvironmentClient } from "./environment-session-registry";
import { resolveSelectedThreadStopPlan } from "./selected-thread-stop-plan";
import { useRemoteEnvironmentState } from "./use-remote-environment-registry";
import { useThreadSelection } from "./use-thread-selection";

export function useSelectedThreadCommands(input: {
  readonly refreshSelectedThreadGitStatus: (options?: {
    readonly quiet?: boolean;
    readonly cwd?: string | null;
  }) => Promise<unknown>;
  readonly selectedThreadDetail: OrchestrationThread | null;
  readonly selectedThreadQueueCount: number;
  readonly clearSelectedThreadQueue: () => void;
}) {
  const {
    clearSelectedThreadQueue,
    refreshSelectedThreadGitStatus,
    selectedThreadDetail,
    selectedThreadQueueCount,
  } = input;
  const { selectedThread } = useThreadSelection();
  const { savedConnectionsById } = useRemoteEnvironmentState();

  const onRefresh = useCallback(async () => {
    const targets = selectedThread
      ? [selectedThread.environmentId]
      : Object.values(savedConnectionsById).map((connection) => connection.environmentId);

    await Promise.all(
      targets.map(async (environmentId) => {
        const client = getEnvironmentClient(environmentId);
        if (!client) {
          return;
        }

        try {
          const serverConfig = await client.server.getConfig();
          environmentRuntimeManager.patch({ environmentId }, (current) => ({
            ...current,
            serverConfig,
            connectionError: null,
          }));
        } catch (error) {
          environmentRuntimeManager.patch({ environmentId }, (current) => ({
            ...current,
            connectionError:
              error instanceof Error ? error.message : "Failed to refresh remote data.",
          }));
        }
      }),
    );

    if (selectedThread) {
      await refreshSelectedThreadGitStatus({ quiet: true });
    }
  }, [refreshSelectedThreadGitStatus, savedConnectionsById, selectedThread]);

  const onUpdateThreadModelSelection = useCallback(
    async (modelSelection: ModelSelection) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        modelSelection,
      });
    },
    [selectedThread],
  );

  const onUpdateThreadRuntimeMode = useCallback(
    async (runtimeMode: RuntimeMode) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        runtimeMode,
        createdAt: new Date().toISOString(),
      });
    },
    [selectedThread],
  );

  const onUpdateThreadInteractionMode = useCallback(
    async (interactionMode: ProviderInteractionMode) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.interaction-mode.set",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
    },
    [selectedThread],
  );

  const onStopThread = useCallback(async () => {
    const stopPlan = resolveSelectedThreadStopPlan({
      selectedThreadShell: selectedThread,
      selectedThreadDetail,
      queueCount: selectedThreadQueueCount,
    });
    if (!stopPlan) {
      return;
    }

    if (stopPlan.shouldClearQueue) {
      clearSelectedThreadQueue();
    }

    if (!stopPlan.shouldInterrupt) {
      return;
    }

    const client = getEnvironmentClient(stopPlan.environmentId);
    if (!client) {
      return;
    }

    await client.orchestration.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: CommandId.make(uuidv4()),
      threadId: stopPlan.threadId,
      ...(stopPlan.turnId ? { turnId: stopPlan.turnId } : {}),
      createdAt: new Date().toISOString(),
    });
  }, [clearSelectedThreadQueue, selectedThread, selectedThreadDetail, selectedThreadQueueCount]);

  const onRenameThread = useCallback(
    async (title: string) => {
      if (!selectedThread) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      const trimmed = title.trim();
      if (!trimmed || trimmed === selectedThread.title) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: selectedThread.id,
        title: trimmed,
      });
    },
    [selectedThread],
  );

  return {
    onRefresh,
    onUpdateThreadModelSelection,
    onUpdateThreadRuntimeMode,
    onUpdateThreadInteractionMode,
    onRenameThread,
    onStopThread,
  };
}
