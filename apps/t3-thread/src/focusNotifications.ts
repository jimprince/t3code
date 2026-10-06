import type { MessageOrigin } from "@t3tools/shared/messageOrigin";
import type { SavedNotification } from "./types.js";

/** Preserve worker provenance without choosing notification routes or delivery policy. */
export function notificationOrigin(
  notification: Pick<SavedNotification, "sourceThreadId" | "sourceAgentName">,
): MessageOrigin {
  return {
    source: "worker-notification",
    fromThreadId: notification.sourceThreadId,
    ...(notification.sourceAgentName ? { fromName: notification.sourceAgentName } : {}),
  };
}
