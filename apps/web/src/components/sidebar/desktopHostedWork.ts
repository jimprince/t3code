import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentCatalog } from "../../connection/catalog";
import { environmentThreadShells } from "../../state/threads";
import { environmentShell } from "../../state/shell";
import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { countAgentsBlockingIdleRestart } from "./desktopIdleRestart.logic";
/** Re-read live atoms at the install boundary, even before React has rendered an update. */
export function readLocalAgentsBlockingRestart(): number {
  const catalog = appAtomRegistry.get(environmentCatalog.catalogValueAtom);
  if (!catalog.isReady) return 1;
  const hosted = new Set([...catalog.entries].filter(([, entry]) => entry.enabled &&
    (entry.target._tag === "PrimaryConnectionTarget" || isDesktopLocalConnectionTarget(entry.target))).map(([id]) => id));
  for (const id of hosted) {
    if (appAtomRegistry.get(environmentShell.stateValueAtom(id)).status !== "live") return 1;
  }
  return countAgentsBlockingIdleRestart({ threads: appAtomRegistry.get(environmentThreadShells.threadShellsAtom), localEnvironmentIds: hosted });
}
