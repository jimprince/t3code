import type { ThreadMoveBundle } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
export function transferSourceUpdatedAt(bundle: ThreadMoveBundle): DateTime.Utc {
  if (bundle.version === 3) return bundle.projection.thread.updatedAt;
  if (typeof bundle.thread.updatedAt !== "string") throw new Error("Missing source timestamp.");
  return DateTime.makeUnsafe(bundle.thread.updatedAt);
}
