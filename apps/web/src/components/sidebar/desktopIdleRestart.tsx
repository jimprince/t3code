import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { useQueuedMessageStore } from "../../queuedMessageStore";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useThreadShells } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  getDesktopUpdateActionError,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { countAgentsBlockingIdleRestart, IDLE_RESTART_GRACE_MS } from "./desktopIdleRestart.logic";

function isLocalConnectionTarget(target: ConnectionCatalogEntry["target"]): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

/** Live count of local agents that a restart would interrupt. */
export function useLocalAgentsBlockingRestart(): number {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const queuesByThreadKey = useQueuedMessageStore((state) => state.queuesByThreadKey);
  const localEnvironmentIds = useMemo(
    () =>
      new Set(
        environments
          .filter((environment) => isLocalConnectionTarget(environment.entry.target))
          .map((environment) => environment.environmentId),
      ),
    [environments],
  );
  return useMemo(
    () => countAgentsBlockingIdleRestart({ threads, localEnvironmentIds, queuesByThreadKey }),
    [threads, localEnvironmentIds, queuesByThreadKey],
  );
}

/** In-memory: a scheduled restart is a live intent, not a preference. */
export const useIdleRestartStore = create<{
  readonly scheduled: boolean;
  readonly schedule: () => void;
  readonly cancel: () => void;
}>()((set) => ({
  scheduled: false,
  schedule: () => set({ scheduled: true }),
  cancel: () => set({ scheduled: false }),
}));

/** Restarts into the downloaded update, reporting a failure as a toast. */
export function installDownloadedUpdate(): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) return Promise.resolve();
  const reportFailure = (description: string) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not install update", description }),
    );
  return bridge
    .installUpdate()
    .then((result) => {
      const actionError = getDesktopUpdateActionError(result);
      if (actionError) reportFailure(actionError);
    })
    .catch((error: unknown) => {
      reportFailure(error instanceof Error ? error.message : "An unexpected error occurred.");
    });
}

/**
 * Fires a scheduled restart once no local agent has been working for
 * IDLE_RESTART_GRACE_MS. Mounted once for the whole renderer so the schedule
 * survives the sidebar unmounting.
 */
export function DesktopIdleRestartWatcher() {
  return isElectron ? <IdleRestartWatcher /> : null;
}

function IdleRestartWatcher() {
  const scheduled = useIdleRestartStore((state) => state.scheduled);
  const updateState = useDesktopUpdateState();
  const busyAgentCount = useLocalAgentsBlockingRestart();
  const canInstall =
    updateState !== null && resolveDesktopUpdateButtonAction(updateState) === "install";
  const ready = scheduled && canInstall && busyAgentCount === 0;

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      useIdleRestartStore.getState().cancel();
      void installDownloadedUpdate();
    }, IDLE_RESTART_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [ready]);

  return null;
}

/** Offered instead of the plain restart confirmation while local agents are working. */
export function IdleRestartDialog({
  open,
  onOpenChange,
  busyAgentCount,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly busyAgentCount: number;
}) {
  const agents = busyAgentCount === 1 ? "1 agent is" : `${busyAgentCount} agents are`;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Restart when agents finish?</AlertDialogTitle>
          <AlertDialogDescription>
            {`${agents} working on this computer. Restarting now interrupts them. Agents waiting on you and agents on other machines don't count.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="outline"
            onClick={() => {
              onOpenChange(false);
              void installDownloadedUpdate();
            }}
          >
            Restart now
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              useIdleRestartStore.getState().schedule();
              toastManager.add(
                stackedThreadToast({
                  type: "info",
                  title: "Restart scheduled",
                  description:
                    "T3 Code restarts to install the update when agents on this computer finish.",
                }),
              );
            }}
          >
            Restart when agents finish
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
