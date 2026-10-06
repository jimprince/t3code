import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import { useEffect, useMemo } from "react";
import { create } from "zustand";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { isElectron } from "../../env";
import { readLocalAgentsBlockingRestart } from "./desktopHostedWork";
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
import { countAgentsBlockingIdleRestart, makeResumesMonitoring, IDLE_RESTART_GRACE_MS } from "./desktopIdleRestart.logic";

function isLocalConnectionTarget(target: ConnectionCatalogEntry["target"]): boolean {
  return target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(target);
}

/** Live count of local agents that a restart would interrupt. */
export function useLocalAgentsBlockingRestart(): number {
  const threads = useThreadShells();
  const { environments } = useEnvironments();
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
    () => countAgentsBlockingIdleRestart({ threads, localEnvironmentIds, resumesMonitoring: makeResumesMonitoring(environments) }),
    [threads, localEnvironmentIds, environments],
  );
}

/** In-memory: a scheduled restart is a live intent, not a preference. */
export const useIdleRestartStore = create<{
  readonly scheduled: boolean;
  readonly expectedVersion: string | null;
  readonly schedule: (expectedVersion: string) => void;
  readonly cancel: () => void;
}>()((set) => ({
  scheduled: false,
  expectedVersion: null,
  schedule: (expectedVersion) => set({ scheduled: true, expectedVersion }),
  cancel: () => set({ scheduled: false, expectedVersion: null }),
}));

/** Restarts into the downloaded update, reporting a failure as a toast. */
function installDownloadedUpdate(expectedVersion?: string): Promise<void> {
  const bridge = window.desktopBridge;
  if (!bridge) return Promise.resolve();
  const reportFailure = (description: string) =>
    toastManager.add(
      stackedThreadToast({ type: "error", title: "Could not install update", description }),
    );
  return bridge
    .installUpdate(expectedVersion === undefined ? undefined : { expectedVersion })
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
  const expectedVersion = useIdleRestartStore((state) => state.expectedVersion);
  const updateState = useDesktopUpdateState();
  const busyAgentCount = useLocalAgentsBlockingRestart();
  const canInstall =
    updateState !== null && resolveDesktopUpdateButtonAction(updateState) === "install";
  const ready = scheduled && canInstall && updateState?.downloadedVersion === expectedVersion && busyAgentCount === 0;

  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(() => {
      const intent = useIdleRestartStore.getState();
      if (!intent.scheduled || intent.expectedVersion !== expectedVersion || readLocalAgentsBlockingRestart() !== 0) return;
      useIdleRestartStore.getState().cancel();
      void installDownloadedUpdate(expectedVersion ?? undefined);
    }, IDLE_RESTART_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [ready, expectedVersion]);

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
  const updateState = useDesktopUpdateState();
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
              useIdleRestartStore.getState().schedule(updateState?.downloadedVersion ?? "");
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
