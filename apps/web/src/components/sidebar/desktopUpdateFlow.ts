import type {
  DesktopBridge,
  DesktopUpdateActionResult,
  DesktopUpdateState,
} from "@t3tools/contracts";
import { create } from "zustand";

import { ensureLocalApi } from "../../localApi";
import { getDesktopUpdateActionError } from "../desktopUpdate.logic";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { getDesktopUpdateStartConfirmationMessage } from "./desktopUpdateProgress.logic";

/**
 * Where this window's one-click update stands. `failed` outlives the call so the update card
 * can show the reason and Retry; a new start clears it.
 */
export const useDesktopUpdateFlow = create<{
  readonly flow: "idle" | "running" | "failed";
}>(() => ({ flow: "idle" }));

/**
 * Runs the whole update (check, download, verify, install, restart) through the shell's single
 * `startUpdate` call. Resolves with the action result; a rejected call is a failed update too.
 */
async function startDesktopUpdate(
  startUpdate: NonNullable<DesktopBridge["startUpdate"]>,
): Promise<DesktopUpdateActionResult | null> {
  if (useDesktopUpdateFlow.getState().flow === "running") return null;
  useDesktopUpdateFlow.setState({ flow: "running" });
  try {
    const result = await startUpdate();
    useDesktopUpdateFlow.setState({
      flow: result.state.status === "error" ? "failed" : "idle",
    });
    return result;
  } catch (error) {
    useDesktopUpdateFlow.setState({ flow: "failed" });
    throw error;
  }
}

/**
 * The click behind every update button: confirm that agents will be interrupted, then run the
 * whole update. Progress and failure show on the update card; this only reports what the card
 * cannot (a refused request, an unreachable shell).
 */
export async function confirmAndStartDesktopUpdate(
  startUpdate: NonNullable<DesktopBridge["startUpdate"]>,
  state: Pick<DesktopUpdateState, "availableVersion" | "downloadedVersion">,
): Promise<void> {
  try {
    const confirmed = await ensureLocalApi().dialogs.confirm(
      getDesktopUpdateStartConfirmationMessage(state),
    );
    if (!confirmed) return;
    const result = await startDesktopUpdate(startUpdate);
    const actionError =
      result && result.state.status !== "error" ? getDesktopUpdateActionError(result) : null;
    if (actionError) {
      toastManager.add(
        stackedThreadToast({ type: "error", title: "Could not update", description: actionError }),
      );
    }
  } catch (error) {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not update",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      }),
    );
  }
}
