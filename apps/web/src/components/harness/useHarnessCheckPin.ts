import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { HarnessCheckView } from "@t3tools/client-runtime/state/harness-view";
import { useCallback } from "react";

import { readLocalApi } from "../../localApi";
import { setHarnessCheckPinnedCommand } from "../../state/harness";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

const pinLabel = (check: Pick<HarnessCheckView, "pinned">) =>
  check.pinned ? "Unpin from top" : "Pin to top";

/**
 * Pin and unpin for a Harness check, shared by the row menu and the check page. Both are hidden
 * when `pinSupported` is false (an older server), and a failure is a toast, never a silent no-op.
 */
export function useHarnessCheckPin() {
  const run = useOrchestrationCommand(setHarnessCheckPinnedCommand, { reportFailure: false });
  const setPinned = useCallback(
    async (check: HarnessCheckView, pinned: boolean) => {
      const result = await run({
        environmentId: check.routine.environmentId,
        input: { checkKey: check.key, pinned },
      });
      if (result._tag === "Success") return true;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: pinned ? "Could not pin the check" : "Could not unpin the check",
          description: (() => {
            const error = squashAtomCommandFailure(result);
            return error instanceof Error ? error.message : "An error occurred.";
          })(),
        }),
      );
      return false;
    },
    [run],
  );
  /** The row's context menu: one item, Pin to top or Unpin from top. */
  const openMenu = useCallback(
    async (check: HarnessCheckView, position: { x: number; y: number }) => {
      if (!check.pinSupported) return;
      const api = readLocalApi();
      if (!api) return;
      const clicked = await settlePromise(() =>
        api.contextMenu.show([{ id: "pin", label: pinLabel(check) }], position),
      );
      if (clicked._tag === "Failure" || clicked.value !== "pin") return;
      await setPinned(check, !check.pinned);
    },
    [setPinned],
  );
  return { setPinned, openMenu, pinLabel };
}
